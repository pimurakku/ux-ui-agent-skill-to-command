#!/usr/bin/env python3
"""The only thing in this repository that writes `stage:` and `gates:`.

    python3 tools/state.py stage                    print the current stage
    python3 tools/state.py gate G2 pass --evidence <file> <file>
    python3 tools/state.py gate G2 fail --missing "reason" "reason"
    python3 tools/state.py begin analysis            mark which stage is running now
    python3 tools/state.py ask outcome.metric "..." record an open question

Why one writer
    The rule is "advance the stage only on a real gate pass", and a rule that
    lives in prose is a rule every role can break by accident. With a single
    writer the rule is in one function: a pass is the only path that touches
    `stage:`, and no entry is ever removed — a gate that failed stays in the
    record, because that record is what anyone coming back actually reads.

Written by hand rather than with PyYAML: the correcter has to run on a machine
with nothing installed, and this file is called from the same pipeline.
"""
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
YML = Path(os.environ.get("LAZYYY_PROJECT") or (ROOT / "project")) / "project.yml"
MANIFEST = json.loads((ROOT / "tools" / "stages.json").read_text(encoding="utf-8"))
ORDER = ["intake"] + [s["id"] for s in MANIFEST["stages"]]
GATE_STAGE = {s["gate"]: s["id"] for s in MANIFEST["stages"] if s.get("gate")}
GATE_NAME = {
    "G1": "Definition of Ready", "G2": "Analyst handback", "G3": "Design ready to build",
    "G4": "Definition of Done", "G5": "Code review", "G6": "Ready to release",
}


def lines() -> list[str]:
    if not YML.exists():
        sys.exit(f"state.py: ไม่พบ {YML} · ต้องทำ intake ก่อน")
    return YML.read_text(encoding="utf-8").splitlines()


def block(src: list[str], key: str) -> tuple[int, int]:
    """Span of a top-level key, its own comments included. Returns (start, end).

    A blank line ends the block. Without that rule the next section's heading
    comment gets swallowed into this one and moved every time we rewrite.
    """
    start = next((i for i, l in enumerate(src) if re.match(rf"^{key}:", l)), None)
    if start is None:
        return len(src), len(src)
    end = start + 1
    while end < len(src) and src[end].strip() and src[end].startswith((" ", "\t", "#")):
        end += 1
    return start, end


def read_gates(src: list[str]) -> list[dict]:
    s, e = block(src, "gates")
    out: list[dict] = []
    for raw in src[s:e]:
        if raw.lstrip().startswith("#"):
            continue
        item = re.match(r"^  - (\w+): (.*)$", raw)
        field = re.match(r"^    (\w+): ?(.*)$", raw)
        bullet = re.match(r"^      - (.*)$", raw)
        if item:
            out.append({item.group(1): item.group(2).strip()})
        elif field and out:
            # `missing:` opens a list; its value is on the following lines. Read
            # back as the empty string it silently dropped every earlier reason.
            value = field.group(2).strip()
            listy = field.group(1) in ("missing", "evidence")
            out[-1][field.group(1)] = [] if listy and not value else value
        elif bullet and out:
            key = "evidence" if isinstance(out[-1].get("evidence"), list) and \
                not isinstance(out[-1].get("missing"), list) else \
                ("missing" if isinstance(out[-1].get("missing"), list) else "evidence")
            out[-1].setdefault(key, [])
            if isinstance(out[-1][key], list):
                out[-1][key].append(bullet.group(1).strip())
    return out


def emit(gates: list[dict]) -> list[str]:
    out = ["gates:"] if gates else ["gates: []"]
    for g in gates:
        out.append(f"  - id: {g['id']}")
        for k in ("name", "checked", "result", "attempt"):
            if g.get(k):
                out.append(f"    {k}: {g[k]}")
        for key in ("evidence", "missing"):
            items = g.get(key)
            if isinstance(items, list) and items:
                out.append(f"    {key}:")
                out += [f"      - {i}" for i in items]
    return out


def write_gate(gid: str, result: str, missing: list[str], evidence: list[str]) -> None:
    src = lines()
    gates = read_gates(src)
    attempt = sum(1 for g in gates if g["id"] == gid) + 1
    # A pass with no evidence is what GAT-01 exists to catch, so the writer
    # refuses to record one rather than leaving the correcter to find it later.
    if result == "pass" and not evidence:
        sys.exit("state.py: ประตูที่ผ่านต้องมีหลักฐาน · ใส่ --evidence <ไฟล์ที่ตรวจ>")
    gates.append({"id": gid, "name": GATE_NAME.get(gid, gid), "checked": date.today().isoformat(),
                  "result": result, "attempt": str(attempt),
                  "evidence": evidence, "missing": missing})
    s, e = block(src, "gates")
    comments = [l for l in src[s:e] if l.lstrip().startswith("#")]
    src[s:e] = emit(gates) + comments
    YML.write_text("\n".join(src) + "\n", encoding="utf-8")

    if result == "pass":
        owner = GATE_STAGE.get(gid)
        if owner and owner in ORDER and ORDER.index(owner) + 1 < len(ORDER):
            set_stage(ORDER[ORDER.index(owner) + 1])
    print(f"บันทึก {gid} = {result} (ครั้งที่ {attempt}) · ระยะตอนนี้ {current()}")


def set_stage(name: str) -> None:
    src = lines()
    for i, l in enumerate(src):
        if re.match(r"^stage:", l):
            src[i] = f"stage: {name}"
            YML.write_text("\n".join(src) + "\n", encoding="utf-8")
            return
    sys.exit("state.py: ไม่พบบรรทัด stage: ใน project.yml")


def begin(name: str) -> None:
    """Mark the stage that is running now. Never moves backwards.

    Marking what is in progress is not the same as advancing past a gate —
    only `gate ... pass` does that — but the room has to be able to show which
    role is up without anybody inventing a number for it.
    """
    if name not in ORDER:
        sys.exit(f"state.py: ไม่รู้จักระยะ {name}")
    if ORDER.index(name) > ORDER.index(current()):
        set_stage(name)
    print(current())


def current() -> str:
    for l in lines():
        m = re.match(r"^stage:\s*(\S+)", l)
        if m:
            return m.group(1)
    return "?"


def ask(field: str, note: str) -> None:
    src = lines()
    s, e = block(src, "open_questions")
    if s == len(src):
        sys.exit("state.py: ไม่พบ open_questions ใน project.yml")
    entry = [f"  - field: {field}", f"    note: {note}", f"    raised: {date.today().isoformat()}"]
    if src[s].strip() == "open_questions: []":
        src[s:s + 1] = ["open_questions:"] + entry
    else:
        keep = [l for l in src[s + 1:e] if not l.lstrip().startswith("#")]
        comments = [l for l in src[s + 1:e] if l.lstrip().startswith("#")]
        src[s:e] = [src[s]] + keep + entry + comments
    YML.write_text("\n".join(src) + "\n", encoding="utf-8")
    print(f"บันทึกคำถามค้าง · {field}")


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "stage":
        print(current() if len(sys.argv) == 2 else "")
        if len(sys.argv) > 2:
            set_stage(sys.argv[2])
            print(current())
        return 0
    if cmd == "begin":
        begin(sys.argv[2])
        return 0
    if cmd == "gate":
        if len(sys.argv) < 4 or sys.argv[3] not in ("pass", "fail"):
            sys.exit("ใช้: state.py gate G2 pass --evidence <ไฟล์> | fail --missing <เหตุผล>")
        bucket, missing, evidence = None, [], []
        for arg in sys.argv[4:]:
            if arg == "--missing":
                bucket = missing
            elif arg == "--evidence":
                bucket = evidence
            elif arg.strip() and bucket is not None:
                bucket.append(arg.strip())
        write_gate(sys.argv[2], sys.argv[3], missing, evidence)
        return 0
    if cmd == "ask":
        ask(sys.argv[2], " ".join(sys.argv[3:]))
        return 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main())
