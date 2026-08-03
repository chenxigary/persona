#!/usr/bin/env python3
"""Persona's isolated LiteAvatar JSON-lines worker.

The worker is intentionally tiny: Persona owns capture, lifecycle, buffering,
and presentation; OpenAvatarChat owns model inference. Protocol messages use
stdin/stdout while every imported library log is redirected to stderr.
"""

import os


# Thread limits have to be set before numpy/torch/onnxruntime are imported.
_THREADS = os.environ.get("P0_AVATAR_THREADS", "2")
for _name in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
):
    os.environ.setdefault(_name, _THREADS)

import base64
import binascii
import json
import re
import sys
import threading
import time
import traceback


# Some OpenAvatarChat dependencies install stdout loggers during import. Keep a
# private duplicate for the protocol, then redirect fd 1 to stderr before any
# third-party import can corrupt the JSON stream.
_PROTOCOL = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)

import numpy as np  # noqa: E402


MAX_AUDIO_BYTES = 64 * 1024
MAX_INPUT_LINE_CHARS = 128 * 1024
SID_PATTERN = re.compile(r"^\d+:\d+$")
_EMIT_LOCK = threading.Lock()


def log(message):
    print(f"LITEAVATAR_WORKER: {message}", file=sys.stderr, flush=True)


def emit(message):
    with _EMIT_LOCK:
        _PROTOCOL.write(json.dumps(message, separators=(",", ":")) + "\n")
        _PROTOCOL.flush()


def bounded_int(value, fallback, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


class State:
    processor = None
    audio_sample_rate = 24_000
    output_width = 448
    output_height = 960
    frames = 0
    started = False
    emit_audio = False
    stop_event = threading.Event()


STATE = State()


def cover_frame(image):
    """Resize a BGR frame to the requested surface with a centered crop."""
    import cv2

    height, width = image.shape[:2]
    target_width = STATE.output_width
    target_height = STATE.output_height
    scale = max(target_width / width, target_height / height)
    scaled_width = max(target_width, round(width * scale))
    scaled_height = max(target_height, round(height * scale))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(
        image,
        (scaled_width, scaled_height),
        interpolation=interpolation,
    )
    left = (scaled_width - target_width) // 2
    top = (scaled_height - target_height) // 2
    return resized[top : top + target_height, left : left + target_width]


def make_output_handler():
    import cv2
    from handlers.avatar.liteavatar.avatar_output_handler import AvatarOutputHandler

    class PersonaOutputHandler(AvatarOutputHandler):
        def on_start(self, init_option):
            log(f"processor started: {init_option}")

        def on_stop(self):
            log("processor stopped")

        def on_video(self, video_result):
            try:
                image = video_result.video_frame.to_ndarray(format="bgr24")
                image = cover_frame(image)
                encoded, jpeg = cv2.imencode(
                    ".jpg",
                    image,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 82],
                )
                if not encoded:
                    return
                STATE.frames += 1
                emit(
                    {
                        "t": "v",
                        "sid": str(video_result.speech_id or ""),
                        "jpg": base64.b64encode(jpeg.tobytes()).decode("ascii"),
                    }
                )
            except Exception:
                log(traceback.format_exc())

        def on_audio(self, audio_result):
            if not STATE.emit_audio:
                return
            try:
                frame = audio_result.audio_frame
                pcm = frame.to_ndarray().astype(np.int16).tobytes()
                emit(
                    {
                        "t": "a",
                        "sid": str(audio_result.speech_id or ""),
                        "sr": int(frame.sample_rate),
                        "chunk": base64.b64encode(pcm).decode("ascii"),
                    }
                )
            except Exception:
                log(traceback.format_exc())

        def on_avatar_status_change(self, speech_id, avatar_status):
            emit(
                {
                    "t": "s",
                    "sid": str(speech_id or ""),
                    "status": avatar_status.name,
                }
            )

    return PersonaOutputHandler()


def heartbeat():
    try:
        import psutil

        process = psutil.Process()
    except Exception:
        psutil = None
        process = None

    last_frames = 0
    last_time = time.time()
    swap_baseline = None
    while not STATE.stop_event.wait(5):
        now = time.time()
        fps = (STATE.frames - last_frames) / max(0.001, now - last_time)
        last_frames = STATE.frames
        last_time = now
        message = {"t": "hb", "fps": round(fps, 1)}
        if process is not None:
            message["rss_mb"] = round(process.memory_info().rss / (1024 * 1024))
            virtual_memory = psutil.virtual_memory()
            swap = psutil.swap_memory()
            message["sys_free_mb"] = round(virtual_memory.available / (1024 * 1024))
            swap_mb = round(swap.used / (1024 * 1024))
            if swap_baseline is None:
                swap_baseline = swap_mb
            message["swap_delta_mb"] = swap_mb - swap_baseline
        emit(message)


def handle_init(request):
    if STATE.started:
        raise RuntimeError("LiteAvatar is already initialized.")
    started_at = time.time()
    oac_directory = os.path.realpath(str(request["oac_dir"]))
    if not os.path.isdir(os.path.join(oac_directory, "src", "handlers", "avatar")):
        raise RuntimeError("OpenAvatarChat runtime is incomplete.")
    sys.path.insert(0, oac_directory)
    sys.path.insert(0, os.path.join(oac_directory, "src"))

    import torch

    torch.set_num_threads(bounded_int(_THREADS, 2, 1, 16))

    from handlers.avatar.liteavatar.algo.tts2face_cpu_adapter import Tts2faceCpuAdapter
    from handlers.avatar.liteavatar.avatar_processor import AvatarProcessor
    from handlers.avatar.liteavatar.model.algo_model import AvatarInitOption

    STATE.audio_sample_rate = bounded_int(
        request.get("audio_sr"), 24_000, 8_000, 48_000
    )
    STATE.output_width = bounded_int(request.get("w"), 448, 128, 1920)
    STATE.output_height = bounded_int(request.get("h"), 960, 128, 1920)
    STATE.emit_audio = request.get("emit_audio") is True
    option = AvatarInitOption(
        audio_sample_rate=STATE.audio_sample_rate,
        video_frame_rate=bounded_int(request.get("fps"), 25, 5, 60),
        avatar_name=str(request.get("avatar_name") or "20250408/sample_data")[:160],
        debug=request.get("debug") is True,
        enable_fast_mode=request.get("fast") is not False,
        use_gpu=request.get("use_gpu") is True,
    )
    adapter = Tts2faceCpuAdapter(
        handler_root=os.path.join(
            oac_directory,
            "src",
            "handlers",
            "avatar",
            "liteavatar",
        )
    )
    processor = AvatarProcessor(adapter, option)
    processor.register_output_handler(make_output_handler())
    processor.start()
    STATE.processor = processor
    STATE.started = True
    threading.Thread(target=heartbeat, daemon=True).start()
    load_seconds = round(time.time() - started_at, 1)
    log(
        f"init done in {load_seconds}s "
        f"(fps={option.video_frame_rate}, fast={option.enable_fast_mode}, "
        f"device={os.environ.get('P0_AVATAR_TORCH_DEVICE') or 'cpu'})"
    )
    return {"ok": True, "load_s": load_seconds}


def handle_audio(request):
    if not STATE.started:
        raise RuntimeError("LiteAvatar is not initialized.")
    sid = str(request.get("sid") or "")
    if not SID_PATTERN.fullmatch(sid):
        raise ValueError("Invalid speech id.")
    encoded = request.get("chunk") or ""
    if not isinstance(encoded, str) or len(encoded) > MAX_AUDIO_BYTES * 2:
        raise ValueError("Audio chunk is too large.")
    try:
        pcm = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Invalid audio base64.") from error
    if len(pcm) > MAX_AUDIO_BYTES or len(pcm) % 2 != 0:
        raise ValueError("Audio must be bounded mono s16le PCM.")

    from handlers.avatar.liteavatar.model.audio_input import SpeechAudio

    STATE.processor.add_audio(
        SpeechAudio(
            speech_id=sid,
            sample_rate=STATE.audio_sample_rate,
            audio_data=pcm,
            end_of_speech=request.get("end") is True,
        )
    )


def shutdown():
    STATE.stop_event.set()
    if STATE.processor is not None:
        try:
            STATE.processor.stop()
        except Exception:
            log(traceback.format_exc())
    log("worker exit")


def main():
    try:
        for raw_line in sys.stdin:
            if len(raw_line) > MAX_INPUT_LINE_CHARS:
                emit({"error": "input line too large"})
                continue
            line = raw_line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("Protocol message must be an object.")
                command = request.get("cmd")
                if command == "init":
                    emit(handle_init(request))
                elif command == "audio":
                    handle_audio(request)
                elif command == "interrupt":
                    if STATE.processor is not None:
                        STATE.processor.interrupt()
                elif command == "stop":
                    break
                else:
                    raise ValueError("Unknown command.")
            except Exception as error:
                log(traceback.format_exc())
                emit({"error": str(error)[:300]})
    finally:
        shutdown()


if __name__ == "__main__":
    main()
