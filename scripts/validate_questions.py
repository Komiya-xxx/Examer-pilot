"""Validate a UTF-8 batch of reviewed questions without writing to the database."""

import argparse
import json
import sys
from pathlib import Path
from typing import BinaryIO

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "questions.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
VALIDATOR = Draft202012Validator(SCHEMA)


class QuestionInputError(Exception):
    """A question batch could not be read or fails the shared contract."""

    def __init__(self, source: str, errors: list[str]) -> None:
        super().__init__(f"{source}: {errors[0]}" if len(errors) == 1 else source)
        self.source = source
        self.errors = errors


def _format_error(error: ValidationError) -> str:
    if error.validator in {"required", "additionalProperties"}:
        detail = error.message
    elif error.validator == "pattern":
        detail = "text must not be blank"
    elif error.validator == "not":
        detail = "text contains a NUL character or an unpaired surrogate"
    else:
        detail = f"expected {error.validator} {error.validator_value!r}"

    return f"{error.json_path}: {detail}"


def validate_questions(document: object) -> list[str]:
    errors = [_format_error(error) for error in VALIDATOR.iter_errors(document)]
    if errors:
        return errors

    versions: set[tuple[str, int]] = set()
    for question_index, question in enumerate(document):
        version_no = question["version_no"]
        if type(version_no) is not int:
            errors.append(f"$[{question_index}].version_no: use an integer JSON literal")

        version = (question["external_id"], version_no)
        if version in versions:
            errors.append(f"$[{question_index}]: duplicate external_id and version_no")
        versions.add(version)

        option_ids: set[str] = set()
        for option_index, option in enumerate(question["options"]):
            option_id = option["id"]
            if option_id in option_ids:
                errors.append(
                    f"$[{question_index}].options[{option_index}].id: duplicate option ID"
                )
            option_ids.add(option_id)

    return errors


def _unique_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise ValueError(f"duplicate JSON member {name!r}")
        result[name] = value
    return result


def _reject_non_json_number(value: str) -> None:
    raise ValueError(f"invalid JSON number {value!r}")


def read_questions(binary_stream: BinaryIO, source: str) -> object:
    """Strictly decode one UTF-8 JSON batch from a binary stream.

    Raises ``QuestionInputError`` for invalid UTF-8, malformed JSON, duplicate
    object members and non-finite numbers such as ``NaN``.
    """
    try:
        text = binary_stream.read().decode("utf-8-sig")
        return json.loads(
            text,
            object_pairs_hook=_unique_members,
            parse_constant=_reject_non_json_number,
        )
    except (OSError, ValueError, RecursionError) as error:
        raise QuestionInputError(source, [str(error)]) from None


def load_questions(path: Path) -> object:
    """Read and validate ``path`` through the shared reader and validator."""
    with path.open("rb") as source:
        try:
            document = read_questions(source, str(path))
        except QuestionInputError as error:
            errors = [f"{path}: {detail}" for detail in error.errors]
            raise QuestionInputError(str(path), errors) from None

    errors = validate_questions(document)
    if errors:
        raise QuestionInputError(str(path), [f"{path}: {error}" for error in errors])
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="UTF-8 JSON question batch")
    args = parser.parse_args(argv)

    try:
        document = load_questions(args.file)
    except QuestionInputError as error:
        for message in error.errors:
            print(message, file=sys.stderr)
        return 1

    print(f"{args.file}: validated {len(document)} question(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
