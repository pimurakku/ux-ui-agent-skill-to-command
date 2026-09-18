#!/usr/bin/env python3
"""Resolve one stage of the pipeline from tools/stages.json.

    python3 tools/stage.py list                 stage ids, in order
    python3 tools/stage.py field <stage> agent  one field of that stage
    python3 tools/stage.py prompt <stage>       the task, with real document codes

Why this exists
    The pipeline used to carry document names as literal text — `PRD-HWK-001`
    written out in the shell script, once per stage. Pointed at any other
    project it asked for a document that project will never have, and then
    reported every stage as producing nothing.

    Document codes come from `meta.code` in project.yml and nowhere else. If it
    cannot be read, this exits non-zero rather than guessing a code: a run that
    invents document names is worse than a run that refuses to start.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "correcter"))
import project_config as cfg  # noqa: E402

MANIFEST = json.loads((ROOT / "tools" / "stages.json").read_text(encoding="utf-8"))
STAGES = {s["id"]: s for s in MANIFEST["stages"]}
ORDER = [s["id"] for s in MANIFEST["stages"]]


def resolve(text: str) -> str:
    """Replace {{CODE}}, {{PRD}} and {{PRD_PATH}} with what this project calls them."""
    code = cfg.code()
    if not code:
        sys.exit("stage.py: อ่าน meta.code จาก project/project.yml ไม่ได้ · "
                 "ต้องทำ intake ให้เสร็จก่อน · ห้ามเดารหัสโครงการ")
    out = text.replace("{{CODE}}", code)
    for kind, folder in MANIFEST["docs"].items():
        doc = f"{kind}-{code}-001"
        out = out.replace(f"{{{{{kind}_PATH}}}}", f"project/{folder}/{doc}.md")
        out = out.replace(f"{{{{{kind}}}}}", doc)
    left = re.findall(r"\{\{[A-Z_]+\}\}", out)
    if left:
        sys.exit(f"stage.py: ไม่รู้จักตัวแทนค่า {sorted(set(left))}")
    return out


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "list":
        print("\n".join(ORDER))
        return 0
    if len(sys.argv) < 3 or sys.argv[2] not in STAGES:
        sys.exit(f"stage.py: ไม่รู้จักระยะ · มีให้เลือก {' '.join(ORDER)}")
    stage = STAGES[sys.argv[2]]
    if cmd == "prompt":
        print(resolve(stage["task"]))
        return 0
    if cmd == "field":
        value = stage.get(sys.argv[3])
        print("" if value is None else resolve(str(value)))
        return 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main())
