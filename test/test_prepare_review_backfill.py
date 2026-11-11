import unittest

from scripts.prepare_review_backfill import reviewed_rows


QUESTIONS = [{
    "external_id": "synthetic-001", "version_no": 1, "question_type": "single_choice",
    "stem": "Which shape has three sides?",
    "options": [{"id": "A", "text": "Circle"}, {"id": "B", "text": "Triangle"}],
}]

REVIEWED = """\
### 01. Which shape has three sides?

- **A.** Circle
- **B.** Triangle

**答案** B. Triangle

**解析** A triangle has three sides.

**复习资料** Internal reference.
"""


class ReviewBackfillTests(unittest.TestCase):
    def test_extracts_only_matching_key_and_explanation(self):
        row, = reviewed_rows(QUESTIONS, REVIEWED)
        self.assertEqual(row["standard_answer"], "B")
        self.assertEqual(row["explanation"], "A triangle has three sides.")
        self.assertEqual(row["version_no"], 1)

    def test_rejects_changes_to_source_alignment(self):
        invalid = (
            REVIEWED.replace("### 01.", "### 02."),
            REVIEWED.replace("three sides?", "four sides?"),
            REVIEWED.replace("- **A.** Circle\n- **B.** Triangle", "- **B.** Triangle\n- **A.** Circle"),
            REVIEWED.replace("**答案** B.", "**答案** A."),
            REVIEWED.replace("**解析** A triangle has three sides.", ""),
        )
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(ValueError):
                reviewed_rows(QUESTIONS, source)


if __name__ == "__main__":
    unittest.main()
