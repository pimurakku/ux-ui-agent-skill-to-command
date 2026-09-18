#!/usr/bin/env python3
"""correcter — ตรวจความถูกต้องของทั้งโครงการ แล้วตัดสินว่าเดินต่อได้หรือไม่

    python3 tools/correcter/verify.py           ตรวจทั้งหมด
    python3 tools/correcter/verify.py --json    ผลเป็น JSON สำหรับ orchestrator
    python3 tools/correcter/verify.py --check document_consistency
    python3 tools/correcter/verify.py --gate G2  ตรวจเฉพาะสิ่งที่กั้นประตูนั้น

รหัสออก
    0  PASS       ผ่าน เดินต่อได้
    1  CORRECTED  พบข้อบกพร่องที่แก้ได้เอง · orchestrator ต้องแก้แล้วเรียกซ้ำ
    2  BLOCKED    ต้องใช้คนหรือข้อมูลจากโลกจริง · เดินต่อไม่ได้

เหตุผลที่แยกรหัส 1 กับ 2 ออกจากกัน
    รหัส 1 คือสิ่งที่ระบบอัตโนมัติควรจัดการเอง
    รหัส 2 คือสิ่งที่ระบบอัตโนมัติ **ต้องไม่** จัดการเอง
    การรวมสองอย่างนี้เป็นรหัสเดียว คือจุดที่ระบบเริ่มปลอมการยืนยัน
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import checks  # noqa: E402
from claims import Level, Report, Verdict  # noqa: E402

EXIT = {Verdict.PASS: 0, Verdict.CORRECTED: 1, Verdict.BLOCKED: 2}
MARK = {Level.VERIFIED: "ตรวจแล้ว", Level.ASSERTED: "ยังไม่มีฐาน", Level.CONTRADICTED: "ขัดแย้ง"}


GATES = ["G1", "G2", "G3", "G4", "G5", "G6"]


def scope(report: Report, gate: str) -> Report:
    """เหลือเฉพาะข้ออ้างที่เกี่ยวกับประตูนี้ · ใช้ตอนสายงานเดินทีละระยะ

    ความขัดแย้งกับของจริงนับทุกข้อเสมอ ไม่ว่าจะอยู่ประตูไหน — ของที่ขัดกับ
    ความจริงไม่ได้หายไปเพราะเรากำลังถามเรื่องอื่น

    ส่วนข้ออ้างที่ยังไม่มีฐาน ถ้ามันค้ำประตูที่ยังมาไม่ถึง ก็ยังไม่ใช่คำถามของรอบนี้
    (SRS ที่ยังไม่มี ไม่ควรกั้นการตรวจ PRD)
    """
    if gate not in GATES:
        sys.exit(f"ไม่รู้จักประตู {gate} · มีให้เลือก {' '.join(GATES)}")
    limit = GATES.index(gate)
    kept = Report()
    for c in report.claims:
        later = c.blocks_gate in GATES and GATES.index(c.blocks_gate) > limit
        if c.level is Level.ASSERTED and later:
            continue
        kept.add(c)
    return kept


def run(selected: str | None = None) -> Report:
    report = Report()
    for fn in checks.ALL:
        if selected and fn.__name__ != f"check_{selected}":
            continue
        for c in fn():
            report.add(c)
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check")
    ap.add_argument("--gate", help="ตรวจเฉพาะสิ่งที่กั้นประตูนั้น เช่น G2")
    ap.add_argument("--brief", action="store_true",
                    help="พิมพ์เฉพาะข้อที่ยังไม่ผ่าน บรรทัดละข้อ · ให้สายงานอัตโนมัติส่งกลับเข้าเทิร์นถัดไป")
    a = ap.parse_args()

    report = run(a.check)
    if a.gate:
        report = scope(report, a.gate)
    verdict = report.verdict()

    if a.brief:
        for c in report.contradicted:
            print(f"{c.id} · {c.text}" + (f" · แก้ได้ด้วย {c.fix}" if c.fix else ""))
        for c in report.asserted:
            if c not in report.standing:
                print(f"{c.id} · {c.text}")
        return EXIT[verdict]

    if a.json:
        print(json.dumps({
            "verdict": verdict.value,
            "counts": {
                "verified": len(report.verified),
                "asserted": len(report.asserted),
                "contradicted": len(report.contradicted),
            },
            "claims": [{
                "id": c.id, "level": c.level.value, "text": c.text,
                "evidence": c.evidence, "fix": c.fix, "blocks_gate": c.blocks_gate,
            } for c in report.claims],
        }, ensure_ascii=False, indent=2))
        return EXIT[verdict]

    width = max((len(c.id) for c in report.claims), default=6)
    blocking = [c for c in report.asserted if c not in report.standing]

    for group, title in ((report.contradicted, "ขัดแย้งกับของจริง"),
                         (blocking, "ยังไม่มีความจริงให้เทียบ และกั้นสายงาน"),
                         (report.verified, "ตรวจกับของจริงแล้ว")):
        if not group:
            continue
        print(f"\n── {title} · {len(group)} ข้อ")
        for c in group:
            print(f"  {c.id.ljust(width)}  {c.text}")
            if c.fix:
                print(f"  {' ' * width}  แก้ได้ด้วย: {c.fix}")

    # เงื่อนไขที่ยังเปิดอยู่ แต่มีกลไกอื่นบังคับ · ต้องไม่หายไปจากรายงาน
    # เงื่อนไขที่ถูกย้ายออกจากคำตัดสินแล้วไม่ถูกรายงาน คือเงื่อนไขที่ถูกยกเลิกเงียบๆ
    if report.standing:
        print(f"\n── เงื่อนไขที่ยังเปิดอยู่ · {len(report.standing)} ข้อ")
        print("   ไม่กั้นสายงาน เพราะมีกลไกบังคับของตัวเอง — แต่ยังไม่หายไป")
        for c in report.standing:
            print(f"\n  {c.id.ljust(width)}  {c.text}")
            print(f"  {' ' * width}  กั้น: {c.blocks.value}")
            print(f"  {' ' * width}  บังคับด้วย: {c.enforced_by}")

    print(f"\n{'═' * 60}")
    print(f"คำตัดสิน: {verdict.value}")
    if verdict is Verdict.CORRECTED:
        print("  มีข้อบกพร่องที่แก้ได้เอง · แก้แล้วเรียกซ้ำ")
    elif verdict is Verdict.BLOCKED:
        print("  สายงานเดินต่อไม่ได้")
    elif report.standing:
        print("  สายงานเดินได้ · แต่เงื่อนไขที่ยังเปิดอยู่ข้างบนยังไม่หมดไป")
    return EXIT[verdict]


if __name__ == "__main__":
    sys.exit(main())
