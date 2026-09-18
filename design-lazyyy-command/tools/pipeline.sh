#!/usr/bin/env bash
# pipeline — drive the stages in tools/stages.json, one focused call per role,
# and let the correcter rule after every single one of them.
#
#   bash tools/pipeline.sh                run every stage from where the project is
#   bash tools/pipeline.sh product        run one stage
#
# Two things this file deliberately does not do.
#
# It does not hold the order. That lives in tools/stages.json, and the document
# names come from meta.code in project.yml — the previous version wrote
# the first project's document names into the script, so pointed at any other
# project it asked every
# role for a document that project would never have.
#
# It does not decide whether the work stands. `verify.py --gate Gn` does, after
# every stage rather than once at the end. Running six more stages on top of a
# stage that failed is how a pipeline produces a full set of documents that are
# all built on something nobody checked.
set -uo pipefail
cd "$(dirname "$0")/.."

MAX_ATTEMPTS=2

WORKSPACE="$(readlink project 2>/dev/null)"
WORKSPACE="$(cd "$(dirname "${WORKSPACE:-.}")" 2>/dev/null && pwd)"
ADD=(); [ -d "${WORKSPACE:-}" ] && ADD=(--add-dir "$WORKSPACE")

say()  { printf '\n\033[36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }

if [ ! -e project/project.yml ]; then
  warn "ยังไม่มี project/project.yml · เปิดโปรเจกต์ที่หน้าห้องก่อน แล้วค่อยสั่งสายงาน"
  exit 2
fi

STAGE_TOTAL=$(python3 tools/stage.py list | wc -l | tr -d ' ')
STAGE_N=0

# Each role runs as a top-level `claude -p`, not as a subagent, so no
# SubagentStart hook fires and no desk would ever light up — the room looked
# asleep while a role was working. The stage marker carries the role name so the
# room can wake the right character from this instead.
# STAGE_N is set once per stage by the loop below, never here: a retry is the
# same stage a second time, and a counter that ticked on retries printed
# "ระยะ 9/7" — a progress number that can exceed its own total is not measuring
# anything.
mark() {
  local name="$1" agent="$2" state="${3:-running}"
  python3 - "$name" "$agent" "$STAGE_N" "$STAGE_TOTAL" "$state" <<'PY'
import json, sys, time, pathlib
name, agent, n, total, state = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
log = pathlib.Path(".monitor/events.jsonl")
log.parent.mkdir(exist_ok=True)
rec = {"ts": round(time.time(), 3), "kind": "stage", "stage": name, "agent": agent,
       "index": n, "total": total, "state": state}
with log.open("a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
PY
}

# Announce the run itself, not just its stages. Started from the button or from
# a shell, the room has to show the same thing — and the stop control has to be
# offered in both cases, or it lies about what it can do.
runmark() {
  python3 - "$1" "${2:-}" <<'PY'
import json, sys, time, pathlib, os
state, code = sys.argv[1], sys.argv[2]
log = pathlib.Path(".monitor/events.jsonl"); log.parent.mkdir(exist_ok=True)
rec = {"ts": round(time.time(), 3), "kind": "run", "state": state, "pid": os.getppid()}
if code: rec["code"] = int(code)
with log.open("a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
PY
}

# One turn as one role. `--agent` opens the session as that agent definition, so
# the tool limits in .claude/agents/*.md are enforced by the harness: asked to
# edit a file, `code-reviewer` answers that it has no such tool. Told in a
# prompt not to, it would simply have to be trusted.
#
# The prompt goes in on stdin. `--add-dir` takes a list, so a prompt sitting
# after it is swallowed as another directory and the run dies with
# "Input must be provided either through stdin or as a prompt argument".
# ROLE_OUT keeps what the turn said, so the loop can tell "this role failed" from
# "this account cannot run another turn right now". Retrying the second one just
# spends the same wall three more times and writes three identical gate failures.
ROLE_OUT=""
role() {
  local agent="$1" task="$2"
  printf '%s\n\n%s\n' "$task" "กติกาที่สำคัญกว่าการทำให้เสร็จ
- อ่าน project/project.yml ก่อน · project/ เป็น symlink ชี้ไป $(readlink project)
- เขียนผ่าน project/... เท่านั้น ห้ามสร้าง projects/ ใน repo นี้
- ห้ามแก้ tools/correcter/ และ tools/stages.json ไม่ว่ากรณีใด
- ไม่รู้อะไรให้เขียน TBD — ต้องการ [คน/ข้อมูล] แล้วเพิ่มใน open_questions · ห้ามเดา
- ห้ามแก้ stage: หรือ gates: ใน project.yml — สายงานเป็นคนเขียนให้หลังตัวตรวจตัดสิน
- **ห้ามค้นหา** · ทุก path ที่ต้องใช้บอกไว้ในโจทย์แล้ว
  ห้ามรัน ls -R, find, หรือ grep -r ทั้ง repo · เปิดเฉพาะไฟล์ที่ระบุชื่อมา
ปิดท้ายด้วยบรรทัดเดียวว่าสร้างไฟล์อะไรไว้ที่ไหน" \
    | claude -p --agent "$agent" --permission-mode acceptEdits "${ADD[@]}" 2>&1 \
    | tee /tmp/lazyyy-role.$$ | sed 's/^/    /' | tail -6
  ROLE_OUT="$(cat /tmp/lazyyy-role.$$ 2>/dev/null)"
  rm -f /tmp/lazyyy-role.$$
}

# The wall itself, in the words the CLI uses for it.
hit_limit() {
  case "$ROLE_OUT" in
    *"session limit"*|*"usage limit"*|*"hit your"*limit*|*"rate limit"*) return 0 ;;
    *) return 1 ;;
  esac
}

FAILED=""
STOPPED=0
runmark started
trap 'runmark ended 130' INT TERM

ONLY="${1:-all}"

for STAGE in $(python3 tools/stage.py list); do
  [ "$ONLY" = all ] || [ "$ONLY" = "$STAGE" ] || continue

  AGENT=$(python3 tools/stage.py field "$STAGE" agent)
  GATE=$(python3 tools/stage.py field "$STAGE" gate)
  WANT=$(python3 tools/stage.py field "$STAGE" want)
  EXPECT=$(python3 tools/stage.py field "$STAGE" expect) || exit 2
  TASK=$(python3 tools/stage.py prompt "$STAGE") || exit 2
  [ -z "$EXPECT" ] && { warn "$STAGE ไม่มี expect ใน stages.json"; continue; }

  python3 tools/state.py begin "$STAGE" >/dev/null
  STAGE_N=$((STAGE_N + 1))
  mark "$STAGE" "$AGENT" running
  say "$STAGE · $AGENT → $WANT  ($STAGE_N/$STAGE_TOTAL)"

  ATTEMPT=1
  REASONS=""
  while :; do
    role "$AGENT" "$TASK"

    # A stage that died — usage limit, an error, or simply giving up — used to
    # report `done`, leave the bar at 100%, and show a finished run with three
    # empty stages. The file it was asked for is the only proof that it ran.
    if hit_limit; then
      REASONS="$(printf '%s' "$ROLE_OUT" | tail -2 | tr '\n' ' ')"
      warn "$STAGE หยุดเพราะโควตาการใช้งาน ไม่ใช่เพราะงานไม่ผ่าน · $REASONS"
      warn "รอโควตาคืนแล้วสั่งซ้ำ · ระยะนี้ยังไม่ถูกตัดสิน จึงไม่บันทึกว่าด่านตก"
      mark "$STAGE" "$AGENT" failed
      FAILED="$FAILED $STAGE(โควตา)"
      STOPPED=1
      break
    fi

    if [ ! -s "$EXPECT" ]; then
      REASONS="ไม่ได้ผลลัพธ์ · ไม่พบ $EXPECT"
      warn "$STAGE $REASONS"
    elif [ -z "$GATE" ]; then
      mark "$STAGE" "$AGENT" done
      break
    else
      say "correcter · $GATE"
      REASONS=$(python3 tools/correcter/verify.py --gate "$GATE" --brief 2>&1)
      CODE=$?
      if [ "$CODE" = 0 ]; then
        python3 tools/state.py gate "$GATE" pass \
          --evidence "$EXPECT" "python3 tools/correcter/verify.py --gate $GATE → PASS" >/dev/null
        say "$GATE ผ่าน · บันทึกแล้ว"
        mark "$STAGE" "$AGENT" done
        break
      fi
      printf '%s\n' "$REASONS" | sed 's/^/    /'
    fi

    if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
      mark "$STAGE" "$AGENT" failed
      FAILED="$FAILED $STAGE"
      if [ -n "$GATE" ]; then
        MISS=()
        while IFS= read -r line; do
          [ -n "$line" ] && MISS+=("$line")
        done <<< "$(printf '%s\n' "$REASONS" | head -4)"
        python3 tools/state.py gate "$GATE" fail --missing ${MISS[@]+"${MISS[@]}"} >/dev/null
      fi
      warn "$STAGE ไม่ผ่านหลังพยายาม $MAX_ATTEMPTS ครั้ง · หยุดสายงาน"
      warn "ระยะถัดไปจะสร้างบนของที่ยังไม่ผ่าน จึงไม่เดินต่อ"
      STOPPED=1
      break
    fi

    ATTEMPT=$((ATTEMPT + 1))
    say "$STAGE · รอบที่ $ATTEMPT"
    TASK="$TASK

รอบที่แล้วยังไม่ผ่านตัวตรวจ แก้ให้ครบทุกข้อนี้ในเทิร์นนี้ · ห้ามแก้ด้วยการลดเกณฑ์หรือปิดตัวตรวจ
$REASONS"
    mark "$STAGE" "$AGENT" running
  done

  [ "$STOPPED" = 1 ] && break
done

say "คำตัดสินรวม"
python3 tools/correcter/verify.py 2>&1 | tail -6
CODE=${PIPESTATUS[0]}
if [ -n "$FAILED" ]; then
  warn "ระยะที่ไม่ผ่าน:$FAILED"
  warn "อย่าอ่านคำตัดสินข้างบนว่าเป็นผลของสายงานเต็ม"
fi
case $CODE in
  0) say "PASS — สายงานเดินจบ" ;;
  1) say "CORRECTED — ยังมีข้อที่แก้ได้เอง" ;;
  2) say "BLOCKED — ต้องใช้คนจริง" ;;
esac
runmark ended "$CODE"
say "ไฟล์ที่ได้"
find project/ -type f -not -path '*/.git/*' -not -path '*node_modules*' | sort | sed 's/^/    /'
exit "$CODE"
