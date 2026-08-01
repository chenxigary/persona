#!/usr/bin/env node
"use strict";

/**
 * Checks a PERSONA_DEBUG run against the invariants the macOS listener fix is
 * supposed to hold.
 *
 * Counting successful voice connections by hand is slow and only samples the
 * symptom. The underlying rule is mechanical: Persona must not hold a Core
 * Audio process tap on the target while that target is silent, because a tap
 * present during audio-session negotiation stops the session connecting. The
 * debug log records exactly when the tap is created and released, so the rule
 * can be verified from a normal session instead of from ten cold starts.
 *
 * Usage:
 *   PERSONA_DEBUG=1 npm run demo 2>&1 | tee /tmp/persona.log
 *   # use the voice app normally for a few minutes, then Ctrl-C
 *   node scripts/check-listener-invariants.cjs /tmp/persona.log
 */

const fs = require("node:fs");

// The old churn bug rebuilt the tap on most 1.5s polls. Anything approaching
// that rate means the reattach guard is not doing its job.
const CHURN_PER_MINUTE_LIMIT = 6;
// A rate needs enough events to mean anything. One legitimate tap inside a ten
// second log is 6 per minute, which would otherwise read as churn.
const CHURN_MIN_SAMPLES = 5;
// How long the tap may linger after the last speech before it looks like it is
// not being released. The helper releases after roughly three seconds.
const RELEASE_GRACE_SECONDS = 12;

function parseLine(line) {
  const match = /^\[persona\]\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const at = Date.parse(match[1]);
  if (Number.isNaN(at)) return null;
  const rest = match[2];

  const status = /^listener status\s+(\{.*\})$/.exec(rest);
  if (status) {
    try {
      return { at, kind: "status", status: JSON.parse(status[1]) };
    } catch {
      return null;
    }
  }
  const activity = /^listener activity\s+(\S+)$/.exec(rest);
  if (activity) return { at, kind: "activity", activity: activity[1] };

  const session = /^listener session\s+(true|false)$/.exec(rest);
  if (session) return { at, kind: "session", active: session[1] === "true" };

  return null;
}

function parseLog(text) {
  return text
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

/**
 * Collapses the event stream into the intervals during which a tap existed,
 * recording whether any speech happened inside each one.
 */
function tapIntervals(events) {
  const intervals = [];
  let open = null;
  for (const event of events) {
    if (event.kind === "activity" && open) {
      if (event.activity === "speaking") open.lastSpeechAt = event.at;
      // Speech ends when the gate falls back to listening, so the last activity
      // of any kind marks the end of output far better than the last "speaking"
      // event, which only fires once at the start of a continuous utterance.
      open.lastActivityAt = event.at;
      open.activities.push(event.activity);
    }
    if (event.kind !== "status") continue;
    if (event.status.capturing && !open) {
      open = {
        start: event.at,
        activities: [],
        lastActivityAt: null,
        lastSpeechAt: null,
      };
    } else if (!event.status.capturing && open) {
      intervals.push({ ...open, end: event.at });
      open = null;
    }
  }
  if (open) intervals.push({ ...open, end: null });
  return intervals;
}

function seconds(ms) {
  return Math.round((ms / 1000) * 10) / 10;
}

function summarise(events) {
  const intervals = tapIntervals(events);
  const span =
    events.length > 1 ? (events.at(-1).at - events[0].at) / 60000 : 0;
  const churnPerMinute = span > 0 ? intervals.length / span : 0;

  const silentTaps = intervals.filter(
    (interval) => interval.lastSpeechAt == null,
  );
  const lateReleases = intervals.filter((interval) => {
    if (interval.end == null || interval.lastActivityAt == null) return false;
    return interval.end - interval.lastActivityAt > RELEASE_GRACE_SECONDS * 1000;
  });
  const unreleased = intervals.filter((interval) => interval.end == null);

  return {
    churnPerMinute,
    intervals,
    lateReleases,
    silentTaps,
    spanMinutes: span,
    unreleased,
  };
}

function report(summary) {
  const lines = [];
  const failures = [];

  lines.push(
    `观测时长 ${summary.spanMinutes.toFixed(1)} 分钟，tap 建立 ${summary.intervals.length} 次` +
      (summary.spanMinutes > 0
        ? `（${summary.churnPerMinute.toFixed(1)} 次/分钟）`
        : ""),
  );

  if (summary.intervals.length === 0) {
    lines.push("");
    lines.push("日志里没有任何 tap 建立记录。要么语音应用整个过程都没出声，");
    lines.push("要么 Persona 没匹配到它。先确认对着语音应用说过话再跑一次。");
    return { failures: ["没有可判定的数据"], text: lines.join("\n") };
  }

  lines.push("");
  lines.push("每次 tap 的持续时间与其间的活动：");
  for (const [index, interval] of summary.intervals.entries()) {
    const duration =
      interval.end == null ? "未释放" : `${seconds(interval.end - interval.start)}s`;
    const spoke = interval.lastSpeechAt == null ? "无说话" : "有说话";
    lines.push(`  ${index + 1}. ${duration.padEnd(10)} ${spoke}`);
  }

  lines.push("");
  lines.push("判定：");

  // 1. 抖动
  if (summary.intervals.length < CHURN_MIN_SAMPLES) {
    lines.push(
      `  · 重建频率不判定（只有 ${summary.intervals.length} 次，需要至少 ${CHURN_MIN_SAMPLES} 次才有统计意义）`,
    );
  } else if (summary.churnPerMinute > CHURN_PER_MINUTE_LIMIT) {
    failures.push(
      `tap 重建过于频繁（${summary.churnPerMinute.toFixed(1)} 次/分钟，上限 ${CHURN_PER_MINUTE_LIMIT}）`,
    );
    lines.push(`  ✗ 重建频率 ${summary.churnPerMinute.toFixed(1)} 次/分钟 —— 超过上限，重连守卫可能失效`);
  } else {
    lines.push(`  ✓ 重建频率 ${summary.churnPerMinute.toFixed(1)} 次/分钟，在上限内`);
  }

  // 2. 静默期挂 tap —— 这是导致语音连不上的直接原因
  if (summary.silentTaps.length > 0) {
    failures.push(`有 ${summary.silentTaps.length} 次 tap 期间完全没有说话`);
    lines.push(
      `  ✗ ${summary.silentTaps.length} 次 tap 期间没有任何说话活动 —— 说明在目标静默时也挂了 tap，正是阻断语音会话建立的条件`,
    );
  } else {
    lines.push("  ✓ 每次 tap 期间都有说话活动 —— 没有在静默期占用目标");
  }

  // 3. 释放
  if (summary.lateReleases.length > 0) {
    failures.push(`有 ${summary.lateReleases.length} 次 tap 释放过慢`);
    lines.push(
      `  ✗ ${summary.lateReleases.length} 次在最后一段说话后超过 ${RELEASE_GRACE_SECONDS}s 才释放`,
    );
  } else {
    lines.push(`  ✓ 说话结束后都在 ${RELEASE_GRACE_SECONDS}s 内释放了 tap`);
  }

  if (summary.unreleased.length > 0) {
    lines.push(
      `  · 有 ${summary.unreleased.length} 次 tap 在日志结束时仍然打开（如果是 Ctrl-C 打断的，属正常）`,
    );
  }

  return { failures, text: lines.join("\n") };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write(
      "用法: node scripts/check-listener-invariants.cjs <PERSONA_DEBUG 日志文件>\n",
    );
    process.exitCode = 1;
    return;
  }
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(`读不到日志 ${path}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const events = parseLog(text);
  if (events.length === 0) {
    process.stderr.write(
      "日志里没有可解析的 [persona] 事件。确认启动时带了 PERSONA_DEBUG=1，\n" +
        "并且用的是加了时间戳的版本（debugLog 会输出 ISO 时间）。\n",
    );
    process.exitCode = 1;
    return;
  }

  const { failures, text: output } = report(summarise(events));
  process.stdout.write(`${output}\n\n`);
  if (failures.length > 0) {
    process.stdout.write(`不通过：${failures.join("；")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "通过。Persona 只在目标真正出声时挂 tap，并及时释放——\n" +
      "语音会话协商期间不存在 tap，也就不会被阻断。\n",
  );
}

module.exports = { parseLine, parseLog, report, summarise, tapIntervals };

if (require.main === module) main();
