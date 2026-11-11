import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import load_questions
from scripts.validate_questions import load_questions as validated_batch

FIXTURE = Path(__file__).parent / "fixtures" / "questions.json"


class LoadQuestionsTests(unittest.TestCase):
    def test_output_is_an_exclusive_local_artifact_and_keeps_text_out_of_sql(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "review.sql"
            slug = "中文'); rollback; --"
            args = [str(FIXTURE), "--round-slug", slug, "--reviewed", "--output-sql", str(output)]
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(load_questions.main(args), 0)
                self.assertEqual(load_questions.main(args), 1)
            sql = output.read_text("ascii")
            self.assertNotIn(slug, sql)
            payload = json.loads(base64.b64decode(re.search(r"decode\('([A-Za-z0-9+/=]+)'", sql)[1]))
            self.assertEqual(payload, {"round_slug": slug, "questions": validated_batch(FIXTURE)})

    def test_requires_review_before_read_or_write(self):
        with patch.object(load_questions, "load_questions") as read, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as err:
                load_questions.main([str(FIXTURE), "--round-slug", "draft"])
        self.assertEqual(err.exception.code, 2)
        read.assert_not_called()

    def test_distinct_versions_of_one_logical_question_cannot_share_a_batch(self):
        questions = validated_batch(FIXTURE)
        questions.append({**questions[0], "version_no": 2})
        with self.assertRaisesRegex(load_questions.LoadError, "only one version"):
            load_questions.build_sql(questions, "draft")

    def test_database_refusals_are_reported_without_private_data(self):
        for marker, expected in load_questions.REFUSALS.items():
            with self.subTest(marker=marker):
                stderr = f"ERROR:  EXAMERFRAME_LOAD_{marker}\nDETAIL: private question text".encode()
                failed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=stderr)
                with patch.object(load_questions.subprocess, "run", return_value=failed):
                    with self.assertRaises(load_questions.LoadError) as err:
                        load_questions.run_sql("select 1", None, 1)
                self.assertEqual(str(err.exception), expected)
