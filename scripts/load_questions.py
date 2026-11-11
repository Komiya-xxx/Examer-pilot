"""Load a locally reviewed batch of new question versions into a draft round."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys

try:
    from scripts.validate_questions import QuestionInputError, load_questions
except ModuleNotFoundError:  # python scripts/load_questions.py
    from validate_questions import QuestionInputError, load_questions


LOAD_SQL = """\
begin;
set local role service_role;
create temporary table load_payload on commit drop as
select convert_from(decode('__PAYLOAD__', 'base64'), 'UTF8')::jsonb as data;
create temporary table load_batch on commit drop as
select item.*
from load_payload p cross join lateral jsonb_to_recordset(p.data->'questions') as item(
    external_id text, version_no integer, question_type text, stem text, options jsonb
);

do $load$
declare
    v_round_id uuid;
    v_status text;
    v_constraint text;
begin
    select r.id, r.status into v_round_id, v_status
    from public.evaluation_rounds r
    where r.slug = (select data->>'round_slug' from load_payload)
    for no key update;

    if not found then
        raise exception 'EXAMERFRAME_LOAD_ROUND_MISSING';
    elsif v_status <> 'draft' then
        raise exception 'EXAMERFRAME_LOAD_ROUND_CLOSED';
    end if;

    insert into public.questions (external_id)
    select external_id from load_batch order by external_id
    on conflict (external_id) do nothing;

    with versions as (
        insert into public.question_versions
            (question_id, version_no, question_type, stem, options, review_status)
        select q.id, b.version_no, b.question_type, b.stem, b.options, 'published'
        from load_batch b join public.questions q using (external_id)
        order by b.external_id
        returning id, question_id
    )
    insert into public.round_questions (round_id, question_version_id, question_id)
    select v_round_id, id, question_id from versions;
exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'round_questions_one_active_version_idx' then
        raise exception 'EXAMERFRAME_LOAD_ACTIVE_VERSION';
    end if;
    raise exception 'EXAMERFRAME_LOAD_DUPLICATE_VERSION';
end
$load$;

select 'EXAMERFRAME_LOAD_OK:' || count(*) from load_batch;
commit;
"""

REFUSALS = {
    "ROUND_MISSING": "the target round does not exist",
    "ROUND_CLOSED": "the target round is not a draft",
    "ACTIVE_VERSION": "the target round already enables another version of this question",
    "DUPLICATE_VERSION": "the question version already exists",
}


class LoadError(Exception):
    """A short safe message for a failed batch."""


def build_sql(questions: list[dict], round_slug: str) -> str:
    if not round_slug.strip() or re.search(r"[\x00\ud800-\udfff]", round_slug):
        raise LoadError("use a valid nonblank round slug")
    if len({item["external_id"] for item in questions}) != len(questions):
        raise LoadError("include only one version of each logical question per batch")

    payload = json.dumps(
        {"round_slug": round_slug, "questions": questions},
        ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")
    return LOAD_SQL.replace("__PAYLOAD__", base64.b64encode(payload).decode("ascii"))


def run_sql(statement: str, wsl_distro: str | None, expected_count: int) -> None:
    unix_socket = "unix:///var/run/docker.sock"
    if wsl_distro:
        command = ["wsl.exe", "--distribution", wsl_distro, "--exec", "docker", "--host", unix_socket]
    else:
        host = "npipe:////./pipe/docker_engine" if os.name == "nt" else unix_socket
        command = ["docker", "--host", host]
    command += [
        "exec", "-i", "supabase_db_examerframe",
        "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    ]
    env = {k: v for k, v in os.environ.items() if k != "DOCKER_CONTEXT"}
    try:
        result = subprocess.run(
            command, input=statement.encode("ascii"), capture_output=True, timeout=120, env=env,
        )
    except subprocess.TimeoutExpired:
        raise LoadError("the database operation timed out; verify before retrying") from None
    except OSError:
        raise LoadError("could not start the local Docker command") from None

    if result.returncode:
        # PostgreSQL errors can contain row values or input SQL; return only our known markers.
        error = result.stderr.decode("utf-8", "replace")
        marker = re.search(r"(?m)^ERROR:\s+EXAMERFRAME_LOAD_([A-Z_]+)\s*$", error)
        reason = REFUSALS.get(marker[1]) if marker else None
        raise LoadError(reason or "local PostgreSQL refused the operation or could not be reached")
    if result.stdout.strip() != f"EXAMERFRAME_LOAD_OK:{expected_count}".encode("ascii"):
        raise LoadError("could not confirm the result; verify before retrying")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="validated UTF-8 question JSON")
    parser.add_argument("--round-slug", required=True, help="existing draft round slug")
    parser.add_argument("--reviewed", action="store_true", help="confirm human review and permission to use")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--wsl-distro", help="run Docker inside this WSL distribution")
    target.add_argument("--output-sql", type=Path, help="write SQL to a new private file without connecting")
    args = parser.parse_args(argv)

    if not args.reviewed:
        parser.error("--reviewed is required after confirming the content")
    try:
        questions = load_questions(args.file)
        statement = build_sql(questions, args.round_slug)
        if args.output_sql is None:
            run_sql(statement, args.wsl_distro, len(questions))
            print(f"Loaded {len(questions)} question version(s).")
        else:
            with args.output_sql.open("xb") as stream:
                stream.write(statement.encode("ascii"))
            print(f"Wrote SQL for {len(questions)} question version(s).")
    except QuestionInputError:
        print("Invalid question batch; use scripts.validate_questions for details.", file=sys.stderr)
        return 1
    except OSError:
        print("Could not read input or create a new SQL file.", file=sys.stderr)
        return 1
    except (LoadError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
