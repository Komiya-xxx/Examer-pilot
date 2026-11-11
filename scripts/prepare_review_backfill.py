"""Prepare private SQL to attach reviewed solutions to an existing choice batch."""

import argparse
import base64
import json
from pathlib import Path
import re
import sys

try:
    from scripts.validate_questions import QuestionInputError, load_questions
except ModuleNotFoundError:  # python scripts/prepare_review_backfill.py
    from validate_questions import QuestionInputError, load_questions


QUESTION_HEADING = re.compile(r"^### (\d+)\. (.+)$", re.MULTILINE)
OPTION_LINE = re.compile(r"^- \*\*([A-Z])\.\*\* (.+)$", re.MULTILINE)
ANSWER_LINE = re.compile(r"^\*\*答案\*\* ([A-Z])\. (.+)$", re.MULTILINE)
EXPLANATION_LINE = re.compile(r"^\*\*解析\*\* (.+)$", re.MULTILINE)

BACKFILL_SQL = """\
begin;
create temporary table review_payload on commit drop as
select convert_from(decode('__PAYLOAD__', 'base64'), 'UTF8')::jsonb as data;

do $review$
declare
    batch_id uuid;
    expected integer;
begin
    select r.id into batch_id from public.evaluation_rounds r
    where r.slug = (select data->>'round_slug' from review_payload)
    for no key update;
    if not found then raise exception 'EXAMERFRAME_REVIEW_ROUND_MISSING'; end if;

    create temporary table review_rows on commit drop as
    select item.* from review_payload p cross join lateral jsonb_to_recordset(p.data->'questions') as item(
        external_id text, version_no integer, question_type text, stem text,
        options jsonb, standard_answer jsonb, explanation text
    );
    select count(*) into expected from review_rows;

    create temporary table matched_review_rows on commit drop as
    select v.id as question_version_id,
        public.normalize_review_answer(v.question_type, v.options, p.standard_answer) as standard_answer,
        p.explanation
    from review_rows p
    join public.questions q on q.external_id = p.external_id
    join public.question_versions v on v.question_id = q.id and v.version_no = p.version_no
        and v.question_type = p.question_type and v.stem = p.stem and v.options = p.options
    join public.round_questions rq on rq.question_version_id = v.id and rq.round_id = batch_id and rq.is_active;

    if (select count(*) from matched_review_rows) <> expected or
       (select count(distinct question_version_id) from matched_review_rows) <> expected or
       (select count(*) from public.round_questions where round_id = batch_id and is_active) <> expected then
        raise exception 'EXAMERFRAME_REVIEW_BATCH_MISMATCH';
    end if;
    if exists (
        select 1 from matched_review_rows m
        join examerframe_private.question_feedback f using (question_version_id)
        where (f.standard_answer, f.explanation) is distinct from (m.standard_answer, m.explanation)
    ) then raise exception 'EXAMERFRAME_REVIEW_FEEDBACK_CONFLICT'; end if;

    insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
    select question_version_id, standard_answer, explanation from matched_review_rows
    on conflict (question_version_id) do nothing;
end;
$review$;

select 'EXAMERFRAME_REVIEW_OK:' || count(*) from matched_review_rows;
__FINISH__;
"""


def reviewed_rows(questions: list[dict], markdown: str) -> list[dict]:
    headings = list(QUESTION_HEADING.finditer(markdown))
    if len(headings) != len(questions) or len({q["external_id"] for q in questions}) != len(questions):
        raise ValueError("question count or IDs do not match")
    rows = []
    for index, (question, heading) in enumerate(zip(questions, headings, strict=True)):
        number = index + 1
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        section = markdown[heading.end():end]
        options = [{"id": key, "text": text.strip()} for key, text in OPTION_LINE.findall(section)]
        answers = ANSWER_LINE.findall(section)
        explanations = EXPLANATION_LINE.findall(section)
        if (int(heading[1]) != number or not question["external_id"].endswith(f"-{number:03}")
                or question["question_type"] != "single_choice" or heading[2].strip() != question["stem"]
                or options != question["options"] or len(answers) != 1 or len(explanations) != 1
                or not explanations[0].strip()):
            raise ValueError(f"question {number}: content does not match the approved single-choice version")
        key, text = answers[0]
        if {"id": key, "text": text.strip()} not in options:
            raise ValueError(f"question {number}: reviewed answer does not match its option")
        rows.append({**question, "standard_answer": key, "explanation": explanations[0].strip()})
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("questions", type=Path)
    parser.add_argument("reviewed_markdown", type=Path)
    parser.add_argument("--round-slug", required=True)
    parser.add_argument("--output-sql", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true", help="emit SQL that verifies then rolls back")
    args = parser.parse_args(argv)
    try:
        questions = load_questions(args.questions)
        rows = reviewed_rows(questions, args.reviewed_markdown.read_text(encoding="utf-8-sig"))
        payload = json.dumps({"round_slug": args.round_slug, "questions": rows}, ensure_ascii=False).encode("utf-8")
        sql = BACKFILL_SQL.replace("__PAYLOAD__", base64.b64encode(payload).decode("ascii"))
        sql = sql.replace("__FINISH__", "rollback" if args.dry_run else "commit")
        with args.output_sql.open("xb") as output:
            output.write(sql.encode("ascii"))
    except QuestionInputError:
        print("Invalid question input. Use scripts/validate_questions.py for details.", file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("Could not read the inputs or create a new private SQL file.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"Verified {len(rows)} reviewed questions; private {'rollback' if args.dry_run else 'backfill'} SQL prepared.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
