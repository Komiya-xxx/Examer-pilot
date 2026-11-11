import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from scripts.validate_questions import main, validate_questions


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "questions.json"


class ValidateQuestionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.questions = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def test_supports_all_question_types_and_preserves_option_order(self) -> None:
        options = self.questions[1]["options"]
        options.reverse()
        before = list(options)

        self.assertEqual(validate_questions(self.questions), [])
        self.assertEqual(options, before)

    def test_rejects_empty_or_non_array_documents(self) -> None:
        for invalid_document in ([], self.questions[0]):
            with self.subTest(invalid_document=invalid_document):
                self.assertTrue(validate_questions(invalid_document))

    def test_rejects_missing_and_unknown_fields(self) -> None:
        del self.questions[0]["stem"]
        self.questions[1]["answer_key"] = {"correct_answer": ["A", "C"]}
        self.questions[2]["explanation"] = "Private explanation"
        self.questions[0]["options"][0]["correct"] = True

        errors = validate_questions(self.questions)

        for field in ("stem", "answer_key", "explanation", "correct"):
            self.assertTrue(any(field in error for error in errors))
        self.assertFalse(any("Private explanation" in error for error in errors))

    def test_rejects_invalid_text(self) -> None:
        self.questions[0]["stem"] = " \t\n"
        self.questions[1]["options"][0]["text"] = "bad\x00text"

        errors = validate_questions(self.questions)

        self.assertTrue(any("$[0].stem" in error for error in errors))
        self.assertTrue(any("$[1].options[0].text" in error for error in errors))

    def test_requires_a_positive_postgres_integer_version(self) -> None:
        for version_no in (0, -1, 1.0, 1.25, 2**31, True):
            with self.subTest(version_no=version_no):
                self.questions[0]["version_no"] = version_no
                errors = validate_questions(self.questions)
                self.assertTrue(any("$[0].version_no" in error for error in errors))

    def test_requires_choice_options_and_empty_boolean_options(self) -> None:
        self.questions[0]["options"].pop()
        self.questions[1]["options"] = {"A": "2", "B": "3"}
        self.questions[2]["options"] = [{"id": "T", "text": "True"}]

        errors = validate_questions(self.questions)

        for index in range(3):
            self.assertTrue(any(f"$[{index}].options" in error for error in errors))

    def test_rejects_unsupported_question_type(self) -> None:
        self.questions[0]["question_type"] = "essay"
        errors = validate_questions(self.questions)
        self.assertTrue(any("$[0].question_type" in error for error in errors))

    def test_rejects_duplicate_ids_with_different_option_text(self) -> None:
        options = self.questions[1]["options"]
        options[2]["id"] = options[0]["id"]

        errors = validate_questions(self.questions)

        self.assertIn("$[1].options[2].id: duplicate option ID", errors)

    def test_allows_new_versions_but_rejects_duplicate_version_keys(self) -> None:
        first_question = self.questions[0]
        revised_question = {**first_question, "version_no": 2, "stem": "修订题干"}
        self.questions.append(revised_question)
        self.assertEqual(validate_questions(self.questions), [])

        revised_question["version_no"] = 1
        errors = validate_questions(self.questions)

        self.assertIn("$[3]: duplicate external_id and version_no", errors)

    def test_cli_reports_valid_question_count(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(main([str(FIXTURE_PATH)]), 0)

        self.assertIn("validated 3 question(s)", output.getvalue())

    def test_cli_rejects_malformed_json_and_duplicate_members(self) -> None:
        for content in ('[{"stem":}', '[{"stem":"first","stem":"second"}]', '[NaN]'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "input.json"
                path.write_text(content, encoding="utf-8")
                with redirect_stderr(io.StringIO()) as output:
                    self.assertEqual(main([str(path)]), 1)
                self.assertIn(str(path), output.getvalue())


if __name__ == "__main__":
    unittest.main()
