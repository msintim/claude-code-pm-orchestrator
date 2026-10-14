import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate  # noqa: E402


class CheckSkillTests(unittest.TestCase):
    def setUp(self):
        validate.errors.clear()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def write_skill(self, dirname, frontmatter):
        skill_dir = self.root / dirname
        skill_dir.mkdir()
        path = skill_dir / "SKILL.md"
        path.write_text(f"---\n{frontmatter}\n---\n\n# Body\n", encoding="utf-8")
        return path

    def test_valid_skill_passes(self):
        path = self.write_skill("promo", "name: promo\ndescription: Make a launch video.")
        validate.check_skill(path)
        self.assertEqual(validate.errors, [])

    def test_name_must_equal_directory(self):
        path = self.write_skill("promo", "name: other\ndescription: Make a launch video.")
        validate.check_skill(path)
        self.assertTrue(any("does not match directory" in e for e in validate.errors))

    def test_extra_key_rejected(self):
        path = self.write_skill("promo", "name: promo\ndescription: Make a launch video.\nlicense: MIT")
        validate.check_skill(path)
        self.assertTrue(any("license" in e for e in validate.errors))

    def test_multiline_description_rejected(self):
        for body in ("description: |\n  Line one.\n  Line two.", "description: >-\n  Line one\n  line two"):
            with self.subTest(body=body):
                validate.errors.clear()
                skill_dir = self.root / "promo"
                if skill_dir.exists():
                    (skill_dir / "SKILL.md").unlink()
                    skill_dir.rmdir()
                path = self.write_skill("promo", f"name: promo\n{body}")
                validate.check_skill(path)
                self.assertTrue(validate.errors)

    def test_missing_frontmatter_rejected(self):
        skill_dir = self.root / "promo"
        skill_dir.mkdir()
        path = skill_dir / "SKILL.md"
        path.write_text("# No frontmatter\n", encoding="utf-8")
        validate.check_skill(path)
        self.assertTrue(any("missing YAML frontmatter" in e for e in validate.errors))

    def test_missing_description_rejected(self):
        path = self.write_skill("promo", "name: promo")
        validate.check_skill(path)
        self.assertTrue(validate.errors)


if __name__ == "__main__":
    unittest.main()
