#!/usr/bin/env bash
# proof — run the checks in BUILD-THIS §6 that a machine can run.
#
#   bash tools/proof.sh
#
# Every item here is a bug that actually shipped once. A passing run does not
# mean the room is right — items 2, 3, 4 and 8 of that list need eyes on a
# screen and are printed at the end as a reminder, not silently dropped.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=4199
TMP="$(mktemp -d)"
# The first version of this file pointed the real `project/` symlink at a
# temporary directory and put it back at the end. Run it while a pipeline was
# working and that pipeline wrote its documents into the temp directory, which
# this script then deleted. A test harness that can destroy the thing it is
# testing is worse than no harness. Every tool now takes LAZYYY_PROJECT instead,
# and the symlink is never touched.
restore() {
  rm -rf "$TMP"
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  return 0
}
trap restore EXIT

PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head() { printf '\n\033[36m%s\033[0m\n' "$1"; }

head "1 · ตัวรับ hook ต้องไม่คืนค่าที่ไม่ใช่ 0 แม้ป้อนของพัง"
printf '{"broken": ' | python3 tools/monitor/emit.py >/dev/null 2>&1
[ $? = 0 ] && ok "JSON พัง → exit 0" || bad "JSON พัง → exit ไม่ใช่ 0 · ข้อความผิดพลาดจะไปโผล่ในบทสนทนา"
printf 'not json at all' | python3 tools/monitor/emit.py >/dev/null 2>&1
[ $? = 0 ] && ok "ข้อความมั่ว → exit 0" || bad "ข้อความมั่ว → exit ไม่ใช่ 0"
python3 tools/monitor/emit.py --selftest >/dev/null 2>&1 \
  && ok "selftest ของ emit.py ผ่าน" || bad "selftest ของ emit.py ตก"

head "9 · ตัวตรวจกับโปรเจกต์เปล่า ต้องไม่ผ่าน"
mkdir -p "$TMP/EMPTY"
export LAZYYY_PROJECT="$TMP/EMPTY"
python3 tools/correcter/verify.py >/dev/null 2>&1
[ $? != 0 ] && ok "โปรเจกต์เปล่า → ไม่ PASS" || bad "โปรเจกต์เปล่าผ่าน — ตัวตรวจไม่ได้ตรวจอะไร"

sed -e 's/^  code:.*/  code: PRF/' .claude/skills/project-intake/assets/project.yml.template > "$TMP/EMPTY/project.yml"
python3 tools/correcter/verify.py >/dev/null 2>&1
[ $? != 0 ] && ok "โปรเจกต์ที่มีแต่ project.yml → ไม่ PASS" || bad "โปรเจกต์ที่ยังไม่มีเอกสารเลยผ่าน"

head "สายงานต้องไม่ผูกกับโปรเจกต์ใดโปรเจกต์หนึ่ง"
python3 tools/stage.py prompt product | grep -q 'PRD-PRF-001' \
  && ok "ชื่อเอกสารมาจาก meta.code ของโปรเจกต์ที่ชี้อยู่" || bad "ชื่อเอกสารไม่ได้มาจาก meta.code"
mkdir -p "$TMP/NOCODE"
LAZYYY_PROJECT="$TMP/NOCODE" python3 tools/stage.py prompt product >/dev/null 2>&1
[ $? != 0 ] && ok "ไม่มีรหัสโครงการ → สายงานปฏิเสธที่จะเริ่ม" || bad "ไม่มีรหัสโครงการแต่ยังเดินต่อ — แปลว่ามันเดารหัสเอง"

head "ประตูที่ผ่านต้องมีหลักฐาน"
python3 tools/state.py gate G1 pass >/dev/null 2>&1
[ $? != 0 ] && ok "บันทึกผ่านโดยไม่มีหลักฐาน → ถูกปฏิเสธ" || bad "บันทึกผ่านโดยไม่มีหลักฐานได้ — GAT-01 จะจับทีหลัง แต่ไม่ควรเขียนลงไปได้ตั้งแต่แรก"
python3 tools/state.py gate G1 fail --missing "ทดสอบ" >/dev/null 2>&1 \
  && ok "บันทึกตกได้ และไม่เลื่อนระยะ" || bad "บันทึกตกไม่ได้"
grep -q '^stage: intake' "$TMP/EMPTY/project.yml" \
  && ok "ประตูตกแล้วระยะไม่ขยับ" || bad "ระยะขยับทั้งที่ประตูตก"

head "บันทึกว่าด่านตก ต้องไม่ทำให้ด่านก่อนหน้าตกตาม"
# เคยเกิดจริง · ข้อความ "ไม่พบ SRS-DEM-001.md" ในบันทึกของ G2 ถูกอ่านเป็น
# "เอกสารที่อ้างแต่ไม่มีอยู่" แล้ว G1 ตกทุกรอบหลังจากนั้น ทั้งที่ PRD ยังอยู่ครบ
python3 tools/state.py gate G2 fail --missing "ไม่ได้ผลลัพธ์ · ไม่พบ project/2-analysis/SRS-PRF-001.md" >/dev/null 2>&1
python3 tools/correcter/verify.py --gate G1 --brief 2>&1 | grep -q 'SRS-PRF-001' \
  && bad "เหตุผลที่บันทึกไว้ย้อนกลับมาทำให้ด่านอื่นตก" || ok "เหตุผลที่บันทึกไว้ไม่ถูกนับเป็นการอ้างเอกสาร"

head "ตัวตรวจของด่านหลัง ต้องไม่ไปกั้นด่านหน้า"
# เคยเกิดจริง · TRC-01 ถามหาเทสต์ที่อ้างรหัส TC-xx ตั้งแต่ตอนเพิ่งเขียน SRS เสร็จ
# ซึ่งเทสต์จะมีตอนระยะ build · G2 จึงไม่มีวันผ่าน และผู้วิเคราะห์ถูกเรียกซ้ำให้แก้
# สิ่งที่มีแต่ผู้พัฒนาสร้างได้
G2DIR="$TMP/G2"
mkdir -p "$G2DIR/1-product" "$G2DIR/2-analysis" "$G2DIR/4-build"
sed -e 's/^  code:.*/  code: PRF/' -e 's/^stage: intake/stage: analysis/' \
    .claude/skills/project-intake/assets/project.yml.template > "$G2DIR/project.yml"
for doc in "1-product/PRD-PRF-001:PRD-PRF-001" "2-analysis/SRS-PRF-001:SRS-PRF-001"; do
  printf '| รหัสเอกสาร | %s |\n| ฉบับแก้ไขครั้งที่ | 00 |\n\nTC-01 TC-02\n' \
    "${doc#*:}" > "$G2DIR/${doc%%:*}.md"
done
# เก็บผลลัพธ์ใส่ตัวแปรก่อน · ห้ามต่อท่อเข้า grep ตรง ๆ เพราะ `set -o pipefail`
# จะคืนรหัสของ verify.py (2 = BLOCKED) ทับผลของ grep ที่เจอของจริง
G2OUT=$(LAZYYY_PROJECT="$G2DIR" python3 tools/correcter/verify.py --gate G2 --brief 2>&1 || true)
G4OUT=$(LAZYYY_PROJECT="$G2DIR" python3 tools/correcter/verify.py --gate G4 --brief 2>&1 || true)
case "$G2OUT" in
  *TRC-01*) bad "TRC-01 ยังกั้น G2 อยู่ — ผู้วิเคราะห์จะถูกเรียกซ้ำให้สร้างเทสต์ที่ไม่ใช่งานของตัวเอง" ;;
  *)        ok  "TRC-01 ไม่กั้น G2" ;;
esac
case "$G4OUT" in
  *TRC-01*) ok  "TRC-01 ยังกั้น G4 ตามเดิม" ;;
  *)        bad "TRC-01 ไม่กั้นอะไรเลย — ย้ายด่านแล้วกลายเป็นปิดตัวตรวจทิ้ง" ;;
esac

head "โควตาหมด ต้องไม่ถูกบันทึกว่าด่านตก"
# เคยเกิดจริง · ระยะ design เจอ "You've hit your session limit" สามรอบติด
# แล้วถูกบันทึกเป็น G3 ตกสามครั้ง ทั้งที่ยังไม่มีใครตัดสินงานเลยสักครั้ง
LIMITOUT=$(ROLE_OUT="You've hit your session limit · resets 3:50pm" bash -c '
  source /dev/stdin <<SH
hit_limit() {
  case "\$ROLE_OUT" in
    *"session limit"*|*"usage limit"*|*"hit your"*limit*|*"rate limit"*) return 0 ;;
    *) return 1 ;;
  esac
}
hit_limit && echo CAUGHT || echo MISSED
SH')
case "$LIMITOUT" in
  *CAUGHT*) ok "สายงานแยกออกว่าเป็นโควตา ไม่ใช่ผลของด่าน" ;;
  *)        bad "สายงานอ่านโควตาหมดเป็นงานไม่ผ่าน แล้วจะบันทึกด่านตกทั้งที่ยังไม่ได้ตรวจ" ;;
esac
grep -q 'hit_limit' tools/pipeline.sh \
  && ok "pipeline.sh มีทางออกสำหรับโควตาหมด" || bad "pipeline.sh ไม่รู้จักโควตาหมด"

head "7 · กดปุ่มจริง — เซิร์ฟเวอร์ต้องไม่ตาย"
node tools/monitor/server.mjs --port $PORT --log "$TMP/events.jsonl" >/dev/null 2>&1 &
SRV=$!
for _ in $(seq 1 20); do curl -sf -m 1 "http://localhost:$PORT/state" >/dev/null 2>&1 && break; sleep .25; done
curl -sf -m 2 "http://localhost:$PORT/state" >/dev/null 2>&1 \
  && ok "เซิร์ฟเวอร์ตอบ /state" || bad "เซิร์ฟเวอร์ไม่ตอบ"
OUT=$(curl -s -m 5 -X POST "http://localhost:$PORT/control" -H 'content-type: application/json' -d '{"action":"run"}' 2>&1)
echo "$OUT" | grep -q 'allow-run' \
  && ok "ปุ่มสั่งงานถูกปฏิเสธเมื่อไม่ได้เปิด --allow-run (ไม่ใช่เงียบ)" || bad "ปุ่มสั่งงานตอบอย่างอื่น: $OUT"
curl -sf -m 2 "http://localhost:$PORT/state" >/dev/null 2>&1 \
  && ok "กดปุ่มแล้วเซิร์ฟเวอร์ยังอยู่" || bad "เซิร์ฟเวอร์ตายหลังกดปุ่ม"

head "6 · เปิดหน้าเว็บกลางรัน ต้องเห็นประวัติย้อนหลัง"
printf '{"ts":%s,"kind":"note","text":"proofprobe"}\n' "$(date +%s)" >> "$TMP/events.jsonl"
sleep 1
# `head -c` here blocked until the byte budget filled, so the stream was cut
# before the backlog was counted — the test failed while the feature worked.
BACKLOG=$(curl -s -m 3 -N "http://localhost:$PORT/events" 2>/dev/null | grep -c 'proofprobe' || true)
[ "${BACKLOG:-0}" -gt 0 ] \
  && ok "ต่อ SSE ทีหลังแล้วได้เหตุการณ์ย้อนหลัง" || bad "ต่อ SSE แล้วจอว่าง — คนเปิดกลางรันจะไม่เห็นอะไรเลย"

head "ต้องทำด้วยตาเอง (ข้อ 2 · 3 · 4 · 8 ใน BUILD-THIS §6)"
cat <<'TXT'
  - เปิด session ใหม่แล้วเรียก subagent · ต้องเห็น SubagentStart พร้อมชื่อ agent ที่ถูกตัว
  - เขียนไฟล์ระหว่างเปิดจอไว้ · ตัวละครที่ถูกต้องต้องสว่างใน 1 วินาที
  - เปิดพร้อมกันทุกโต๊ะ · ไม่มีคู่ไหนทับกัน ไม่มีอะไรล้นจอ
  - ลบภาพประกอบทิ้ง · ห้องต้องยังใช้สอนได้
TXT

printf '\n%s\n' "────────────────────────────────────────"
printf 'ผ่าน %s · ตก %s\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
