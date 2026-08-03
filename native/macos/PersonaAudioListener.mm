#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <limits>
#include <memory>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> running{true};

AudioObjectPropertyAddress propertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

void emitJSON(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int fail(NSString *message, OSStatus status = noErr) {
  NSString *detail = message;
  if (status != noErr) {
    detail = [NSString stringWithFormat:@"%@ (OSStatus %d)", message, status];
  }
  emitJSON(@{@"type" : @"error", @"message" : detail});
  return 1;
}

void handleSignal(int) {
  running.store(false, std::memory_order_relaxed);
}

std::vector<AudioObjectID> audioProcessObjects(const std::vector<pid_t>& requestedPids) {
  auto address = propertyAddress(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(
          kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) {
    return {};
  }
  std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
  if (objects.empty() ||
      AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &address, 0, nullptr, &size, objects.data()) != noErr) {
    return {};
  }
  objects.resize(size / sizeof(AudioObjectID));

  std::vector<AudioObjectID> matches;
  for (AudioObjectID object : objects) {
    auto pidAddress = propertyAddress(kAudioProcessPropertyPID);
    pid_t pid = 0;
    UInt32 pidSize = sizeof(pid);
    if (AudioObjectGetPropertyData(object, &pidAddress, 0, nullptr, &pidSize, &pid) != noErr) {
      continue;
    }
    if (std::find(requestedPids.begin(), requestedPids.end(), pid) != requestedPids.end()) {
      matches.push_back(object);
    }
  }
  return matches;
}

// While the target application is negotiating a new audio session, an attached
// process tap can prevent that session from ever being established (observed
// with the ChatGPT desktop client: with a tap attached, the first voice
// connection times out; without one it connects, and a tap attached after the
// session is live is harmless). The helper therefore waits until the target
// reports running output before creating the tap, and releases the tap again
// once output has stopped.
constexpr int kOutputCheckTicks = 30;    // ~1 second at the 33ms meter cadence
constexpr int kOutputStoppedChecks = 3;  // release after ~3 seconds without output
constexpr int kOutputStartPollMilliseconds = 100;
constexpr std::size_t kPcmRingCapacity = 64;
constexpr std::size_t kPcmMaxFramesPerChunk = 4096;

bool anyProcessRunningOutput(const std::vector<AudioObjectID>& processObjects) {
  for (AudioObjectID object : processObjects) {
    auto address = propertyAddress(kAudioProcessPropertyIsRunningOutput);
    UInt32 isRunningOutput = 0;
    UInt32 size = sizeof(isRunningOutput);
    const OSStatus status = AudioObjectGetPropertyData(
        object, &address, 0, nullptr, &size, &isRunningOutput);
    // If the property cannot be read, treat the process as running so the
    // helper degrades to the previous attach-immediately behaviour instead of
    // never attaching at all.
    if (status != noErr) return true;
    if (isRunningOutput != 0) return true;
  }
  return false;
}

struct PcmChunk {
  std::uint64_t sequence = 0;
  UInt32 frames = 0;
  std::array<int16_t, kPcmMaxFramesPerChunk> samples{};
};

bool supportsPcmCopy(const AudioStreamBasicDescription& format) {
  if (format.mFormatID != kAudioFormatLinearPCM) return false;
  if ((format.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0) return false;
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned =
      (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  return (isFloat &&
          (format.mBitsPerChannel == 32 || format.mBitsPerChannel == 64)) ||
         (isSigned &&
          (format.mBitsPerChannel == 16 || format.mBitsPerChannel == 32));
}

double normalizedSampleAt(const AudioBuffer& buffer,
                          std::size_t sampleIndex,
                          const AudioStreamBasicDescription& format) {
  if (buffer.mData == nullptr) return 0.0;
  const std::size_t bytesPerSample = format.mBitsPerChannel / 8;
  if (bytesPerSample == 0 ||
      sampleIndex >= buffer.mDataByteSize / bytesPerSample) {
    return 0.0;
  }
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  if (isFloat && format.mBitsPerChannel == 32) {
    const float value = static_cast<const float *>(buffer.mData)[sampleIndex];
    return std::isfinite(value) ? value : 0.0;
  }
  if (isFloat && format.mBitsPerChannel == 64) {
    const double value = static_cast<const double *>(buffer.mData)[sampleIndex];
    return std::isfinite(value) ? value : 0.0;
  }
  if (format.mBitsPerChannel == 16) {
    return static_cast<double>(
               static_cast<const int16_t *>(buffer.mData)[sampleIndex]) /
           32768.0;
  }
  if (format.mBitsPerChannel == 32) {
    return static_cast<double>(
               static_cast<const int32_t *>(buffer.mData)[sampleIndex]) /
           2147483648.0;
  }
  return 0.0;
}

std::size_t pcmFrameCount(const AudioBufferList *input,
                          const AudioStreamBasicDescription& format) {
  if (input == nullptr || input->mNumberBuffers == 0 ||
      !supportsPcmCopy(format)) {
    return 0;
  }
  const std::size_t bytesPerSample = format.mBitsPerChannel / 8;
  if (bytesPerSample == 0) return 0;
  const bool nonInterleaved =
      (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
  if (!nonInterleaved) {
    if (input->mBuffers[0].mData == nullptr) return 0;
    const std::size_t channels = std::max<UInt32>(1, format.mChannelsPerFrame);
    const std::size_t bytesPerFrame =
        format.mBytesPerFrame > 0
            ? format.mBytesPerFrame
            : bytesPerSample * channels;
    return bytesPerFrame > 0
               ? input->mBuffers[0].mDataByteSize / bytesPerFrame
               : 0;
  }

  std::size_t frames = std::numeric_limits<std::size_t>::max();
  const std::size_t channelBuffers = std::min<std::size_t>(
      input->mNumberBuffers,
      std::max<UInt32>(1, format.mChannelsPerFrame));
  for (std::size_t channel = 0; channel < channelBuffers; ++channel) {
    if (input->mBuffers[channel].mData == nullptr) return 0;
    frames = std::min<std::size_t>(
        frames, input->mBuffers[channel].mDataByteSize / bytesPerSample);
  }
  return channelBuffers > 0 ? frames : 0;
}

UInt32 copyMonoPcm16(const AudioBufferList *input,
                     const AudioStreamBasicDescription& format,
                     int16_t *output,
                     std::size_t capacity) {
  const std::size_t totalFrames = pcmFrameCount(input, format);
  const std::size_t frames = std::min(totalFrames, capacity);
  if (frames == 0 || output == nullptr) return 0;
  const bool nonInterleaved =
      (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
  const std::size_t channels = nonInterleaved
      ? std::min<std::size_t>(
            input->mNumberBuffers,
            std::max<UInt32>(1, format.mChannelsPerFrame))
      : std::max<UInt32>(1, format.mChannelsPerFrame);

  for (std::size_t frame = 0; frame < frames; ++frame) {
    double mono = 0.0;
    for (std::size_t channel = 0; channel < channels; ++channel) {
      const AudioBuffer& buffer =
          input->mBuffers[nonInterleaved ? channel : 0];
      const std::size_t sampleIndex =
          nonInterleaved ? frame : frame * channels + channel;
      mono += normalizedSampleAt(buffer, sampleIndex, format);
    }
    mono = std::clamp(mono / static_cast<double>(channels), -1.0, 1.0);
    const double scaled = mono < 0.0 ? mono * 32768.0 : mono * 32767.0;
    output[frame] = static_cast<int16_t>(scaled);
  }
  return static_cast<UInt32>(frames);
}

// Single-producer/single-consumer and fully preallocated: the Core Audio IO
// callback never waits on a lock, allocates memory, serializes JSON, or writes
// to stdout. When the consumer falls behind, current voice playback wins and
// the avatar loses old PCM chunks.
class PcmRingBuffer {
 public:
  void push(const AudioBufferList *input,
            const AudioStreamBasicDescription& format) {
    const std::uint64_t sequence = nextSequence_++;
    const std::size_t write = writeIndex_.load(std::memory_order_relaxed);
    const std::size_t next = (write + 1) % kPcmRingCapacity;
    if (next == readIndex_.load(std::memory_order_acquire)) {
      dropped_.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    PcmChunk& chunk = chunks_[write];
    chunk.sequence = sequence;
    chunk.frames = copyMonoPcm16(
        input, format, chunk.samples.data(), chunk.samples.size());
    if (chunk.frames == 0) return;
    if (pcmFrameCount(input, format) > chunk.frames) {
      dropped_.fetch_add(1, std::memory_order_relaxed);
    }
    writeIndex_.store(next, std::memory_order_release);
  }

  bool pop(PcmChunk& output) {
    const std::size_t read = readIndex_.load(std::memory_order_relaxed);
    if (read == writeIndex_.load(std::memory_order_acquire)) return false;
    output = chunks_[read];
    readIndex_.store((read + 1) % kPcmRingCapacity, std::memory_order_release);
    return true;
  }

  std::uint64_t takeDropped() {
    return dropped_.exchange(0, std::memory_order_relaxed);
  }

 private:
  std::array<PcmChunk, kPcmRingCapacity> chunks_{};
  std::atomic<std::size_t> readIndex_{0};
  std::atomic<std::size_t> writeIndex_{0};
  std::atomic<std::uint64_t> dropped_{0};
  std::uint64_t nextSequence_ = 0;
};

struct MeterContext {
  AudioStreamBasicDescription format{};
  std::atomic<float> peak{0.0f};
  PcmRingBuffer *pcm = nullptr;
};

double squareSumForBuffer(
    const AudioBuffer& buffer,
    const AudioStreamBasicDescription& format,
    std::size_t& sampleCount) {
  if (buffer.mData == nullptr || buffer.mDataByteSize == 0) return 0.0;
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  double sum = 0.0;

  if (isFloat && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const float *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(float);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isFloat && format.mBitsPerChannel == 64) {
    const auto *samples = static_cast<const double *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(double);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 16) {
    const auto *samples = static_cast<const int16_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int16_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 32768.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const int32_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int32_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 2147483648.0;
      sum += sample * sample;
    }
  }
  return sum;
}

OSStatus meterIOProc(
    AudioObjectID,
    const AudioTimeStamp *,
    const AudioBufferList *input,
    const AudioTimeStamp *,
    AudioBufferList *,
    const AudioTimeStamp *,
    void *clientData) {
  auto *context = static_cast<MeterContext *>(clientData);
  if (input == nullptr || context == nullptr) return noErr;

  double squareSum = 0.0;
  std::size_t sampleCount = 0;
  for (UInt32 index = 0; index < input->mNumberBuffers; ++index) {
    std::size_t bufferSamples = 0;
    squareSum += squareSumForBuffer(input->mBuffers[index], context->format, bufferSamples);
    sampleCount += bufferSamples;
  }
  if (sampleCount == 0) return noErr;

  const double rms = std::sqrt(squareSum / static_cast<double>(sampleCount));
  const float level =
      static_cast<float>(std::clamp((rms - 0.0025) * 7.5, 0.0, 1.0));
  float previous = context->peak.load(std::memory_order_relaxed);
  while (level > previous &&
         !context->peak.compare_exchange_weak(
             previous, level, std::memory_order_relaxed, std::memory_order_relaxed)) {
  }
  if (context->pcm != nullptr) context->pcm->push(input, context->format);
  return noErr;
}

void emitPcmMessages(PcmRingBuffer& ring, Float64 sampleRate) {
  PcmChunk chunk;
  for (std::size_t emitted = 0;
       emitted < kPcmRingCapacity && ring.pop(chunk);
       ++emitted) {
    const NSUInteger byteLength =
        static_cast<NSUInteger>(chunk.frames) * sizeof(int16_t);
    NSData *data = [NSData dataWithBytes:chunk.samples.data()
                                  length:byteLength];
    NSString *encoded = [data base64EncodedStringWithOptions:0];
    emitJSON(@{
      @"type" : @"pcm",
      @"encoding" : @"s16le",
      @"sampleRate" : @(sampleRate),
      @"channels" : @1,
      @"frames" : @(chunk.frames),
      @"sequence" : @(static_cast<unsigned long long>(chunk.sequence)),
      @"data" : encoded,
    });
  }
  const std::uint64_t dropped = ring.takeDropped();
  if (dropped > 0) {
    emitJSON(@{
      @"type" : @"pcm-overflow",
      @"dropped" : @(static_cast<unsigned long long>(dropped)),
    });
  }
}

bool pcmSelfTest() {
  const float left[] = {1.0f, 0.0f, -1.0f};
  const float right[] = {1.0f, 0.5f, 0.0f};
  struct StereoBufferList {
    UInt32 numberBuffers;
    AudioBuffer buffers[2];
  } testInput = {
      2,
      {
          {1, static_cast<UInt32>(sizeof(left)), const_cast<float *>(left)},
          {1, static_cast<UInt32>(sizeof(right)), const_cast<float *>(right)},
      },
  };
  AudioStreamBasicDescription format{};
  format.mSampleRate = 48000;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat |
                        kAudioFormatFlagIsPacked |
                        kAudioFormatFlagIsNonInterleaved;
  format.mBytesPerPacket = sizeof(float);
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(float);
  format.mChannelsPerFrame = 2;
  format.mBitsPerChannel = 32;

  PcmRingBuffer ring;
  ring.push(reinterpret_cast<const AudioBufferList *>(&testInput), format);
  PcmChunk output;
  if (!ring.pop(output) || output.sequence != 0 || output.frames != 3) {
    return false;
  }
  return output.samples[0] == 32767 && output.samples[1] == 8191 &&
         output.samples[2] == -16384;
}

// Creates the tap and aggregate device for the given process objects, meters
// output levels until the helper is terminated or the target stops producing
// output, then tears the Core Audio objects down again. Returns 0 when the
// cycle ended cleanly and a process exit code when setup failed.
int runMeterCycle(const std::vector<pid_t>& processIds,
                  const std::vector<AudioObjectID>& processObjects,
                  bool emitPcm) {
  NSMutableArray<NSNumber *> *processNumbers =
      [NSMutableArray arrayWithCapacity:processObjects.size()];
  for (AudioObjectID object : processObjects) {
    [processNumbers addObject:@(object)];
  }
  CATapDescription *tapDescription =
      [[CATapDescription alloc] initStereoMixdownOfProcesses:processNumbers];
  if (tapDescription == nil) {
    return fail(@"Unable to configure the Core Audio process tap.");
  }
  tapDescription.name = @"Persona voice output meter";
  [tapDescription setPrivate:YES];

  AudioObjectID tapID = kAudioObjectUnknown;
  OSStatus status = AudioHardwareCreateProcessTap(tapDescription, &tapID);
  if (status != noErr) return fail(@"Unable to create a Core Audio process tap.", status);

  CFStringRef tapUIDRef = nullptr;
  auto tapUIDAddress = propertyAddress(kAudioTapPropertyUID);
  UInt32 tapUIDSize = sizeof(tapUIDRef);
  status = AudioObjectGetPropertyData(
      tapID, &tapUIDAddress, 0, nullptr, &tapUIDSize, &tapUIDRef);
  if (status != noErr || tapUIDRef == nullptr) {
    AudioHardwareDestroyProcessTap(tapID);
    return fail(@"Unable to read the Core Audio tap identifier.", status);
  }
  NSString *tapUID = [(__bridge NSString *)tapUIDRef copy];
  CFRelease(tapUIDRef);

  NSString *aggregateUID = [NSString stringWithFormat:@"com.xikhar.persona.%@",
                                                      NSUUID.UUID.UUIDString];
  NSDictionary *aggregateDescription = @{
    @kAudioAggregateDeviceNameKey : @"Persona Output Meter",
    @kAudioAggregateDeviceUIDKey : aggregateUID,
    @kAudioAggregateDeviceIsPrivateKey : @YES,
    @kAudioAggregateDeviceTapAutoStartKey : @YES,
  };
  AudioObjectID aggregateID = kAudioObjectUnknown;
  status = AudioHardwareCreateAggregateDevice(
      (__bridge CFDictionaryRef)aggregateDescription, &aggregateID);
  if (status != noErr) {
    AudioHardwareDestroyProcessTap(tapID);
    return fail(@"Unable to create a private Core Audio aggregate device.", status);
  }

  CFArrayRef tapList = (__bridge CFArrayRef)@[ tapUID ];
  auto tapListAddress = propertyAddress(kAudioAggregateDevicePropertyTapList);
  UInt32 tapListSize = sizeof(tapList);
  status = AudioObjectSetPropertyData(
      aggregateID, &tapListAddress, 0, nullptr, tapListSize, &tapList);
  if (status != noErr) {
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return fail(@"Unable to attach the process tap to its aggregate device.", status);
  }

  MeterContext meter;
  std::unique_ptr<PcmRingBuffer> pcmRing;
  // Core Audio publishes the aggregate device's tapped input stream
  // asynchronously after the tap list is attached. Reading the format on the
  // first attempt races that setup and intermittently fails with
  // kAudioHardwareBadObjectError, so poll both scopes until the stream
  // appears rather than giving up immediately.
  const AudioObjectPropertyScope formatScopes[] = {
      kAudioDevicePropertyScopeInput,
      kAudioObjectPropertyScopeGlobal,
  };
  status = kAudioHardwareBadObjectError;
  const auto formatDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (true) {
    for (const AudioObjectPropertyScope scope : formatScopes) {
      auto formatAddress =
          propertyAddress(kAudioDevicePropertyStreamFormat, scope);
      UInt32 formatSize = sizeof(meter.format);
      const OSStatus readStatus = AudioObjectGetPropertyData(
          aggregateID, &formatAddress, 0, nullptr, &formatSize, &meter.format);
      if (readStatus == noErr && meter.format.mSampleRate > 0 &&
          meter.format.mBitsPerChannel > 0) {
        status = noErr;
        break;
      }
      status = readStatus != noErr ? readStatus : kAudioHardwareBadObjectError;
    }
    if (status == noErr) break;
    if (!running.load(std::memory_order_relaxed)) break;
    if (std::chrono::steady_clock::now() >= formatDeadline) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }

  // Terminated while waiting for the tapped stream to appear. Release the
  // objects we already created instead of leaving them behind.
  if (!running.load(std::memory_order_relaxed)) {
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return 0;
  }

  if (status != noErr) {
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return fail(@"Unable to read the tapped stream format.", status);
  }

  if (emitPcm) {
    pcmRing = std::make_unique<PcmRingBuffer>();
    meter.pcm = pcmRing.get();
  }

  AudioDeviceIOProcID ioProcID = nullptr;
  status = AudioDeviceCreateIOProcID(aggregateID, meterIOProc, &meter, &ioProcID);
  if (status == noErr) status = AudioDeviceStart(aggregateID, ioProcID);
  if (status != noErr) {
    if (ioProcID != nullptr) AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return fail(@"Unable to start the Core Audio output meter.", status);
  }

  emitJSON(@{@"type" : @"ready", @"source" : @"macOS process audio"});

  int stoppedChecks = 0;
  int ticksUntilCheck = kOutputCheckTicks;
  while (running.load(std::memory_order_relaxed)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(33));
    @autoreleasepool {
      if (pcmRing != nullptr) emitPcmMessages(*pcmRing, meter.format.mSampleRate);
      const float level = meter.peak.exchange(0.0f, std::memory_order_relaxed);
      emitJSON(@{@"type" : @"level", @"level" : @(level)});
    }
    if (--ticksUntilCheck > 0) continue;
    ticksUntilCheck = kOutputCheckTicks;
    const auto currentObjects = audioProcessObjects(processIds);
    if (currentObjects.empty() || !anyProcessRunningOutput(currentObjects)) {
      if (++stoppedChecks >= kOutputStoppedChecks) break;
    } else {
      stoppedChecks = 0;
    }
  }

  AudioDeviceStop(aggregateID, ioProcID);
  AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
  AudioHardwareDestroyAggregateDevice(aggregateID);
  AudioHardwareDestroyProcessTap(tapID);
  return 0;
}

}  // namespace

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    std::vector<pid_t> processIds;
    bool emitPcm = false;
    bool selfTest = false;
    for (int index = 1; index < argc; ++index) {
      if (strcmp(argv[index], "--emit-pcm") == 0) {
        emitPcm = true;
        continue;
      }
      if (strcmp(argv[index], "--self-test") == 0) {
        selfTest = true;
        continue;
      }
      if (strcmp(argv[index], "--pid") == 0 && index + 1 < argc) {
        const long value = strtol(argv[++index], nullptr, 10);
        if (value > 0) processIds.push_back(static_cast<pid_t>(value));
      }
    }
    if (selfTest) {
      if (!pcmSelfTest()) return fail(@"macOS PCM self-test failed.");
      emitJSON(@{@"type" : @"ready", @"source" : @"macOS self-test"});
      return 0;
    }
    if (processIds.empty()) return fail(@"At least one --pid is required.");

    // Install the signal handlers before creating any Core Audio object. Persona
    // terminates the helper whenever it reattaches, and under the default
    // SIGTERM disposition that kill can land between
    // AudioHardwareCreateProcessTap and the teardown at the end of main, leaking
    // the tap and its private aggregate device.
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);

    // Wait until the target application actually produces output before
    // creating the tap. Attaching earlier — while the application is still
    // negotiating its audio session — can prevent that session from being
    // established at all, and a tap attached once audio is flowing yields the
    // same meter. When output stops again, runMeterCycle releases the tap so
    // the next session can be negotiated without interference.
    bool announcedWaiting = false;
    while (running.load(std::memory_order_relaxed)) {
      @autoreleasepool {
        const auto processObjects = audioProcessObjects(processIds);
        if (!processObjects.empty() && anyProcessRunningOutput(processObjects)) {
          announcedWaiting = false;
          // Tell the parent before constructing any Core Audio object. It must
          // suppress process-membership reattachment until the first meter
          // level arrives, or Electron helper churn can kill this tap midway
          // through setup and add hundreds of milliseconds to the first word.
          emitJSON(@{@"type" : @"attaching"});
          const int outcome =
              runMeterCycle(processIds, processObjects, emitPcm);
          if (outcome != 0) return outcome;
          continue;
        }
        if (!announcedWaiting) {
          emitJSON(@{@"type" : @"waiting"});
          announcedWaiting = true;
        }
      }
      // This only reads the process running-output property; it does not create
      // a tap. A 100ms cadence keeps the protected session-negotiation design
      // while removing up to 150ms from first-mouth response versus the old
      // 250ms poll.
      std::this_thread::sleep_for(
          std::chrono::milliseconds(kOutputStartPollMilliseconds));
    }
    return 0;
  }
}
