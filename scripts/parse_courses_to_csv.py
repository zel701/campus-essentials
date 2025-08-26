#!/usr/bin/env python3
"""
Parse Cal Poly course descriptions (plain text) into CSV.

Input format (example):
AERO 121. Aerospace Fundamentals.
2 units
Term Typically Offered: F
Prerequisite: ... (optional)
Recommended: ... (optional)
Corequisite: ... (optional)
<description lines...>

Output columns:
subject,number,title,units,term,prerequisite,recommended,corequisite,description

Usage:
  python parse_courses_to_csv.py input.txt > courses.csv
  cat input.txt | python parse_courses_to_csv.py > courses.csv
"""

import csv
import re
import sys
from dataclasses import dataclass, asdict
from typing import List, Optional

COURSE_HEADER_RE = re.compile(r"^(?P<subject>[A-Z]{3,5})\s+(?P<number>\d{3})\.\s+(?P<title>.+?)\.$")
UNITS_RE = re.compile(r"^(?P<units>\d+(?:-\d+)?)\s+unit(?:s)?$", re.IGNORECASE)
TERM_RE = re.compile(r"^Term Typically Offered:\s*(?P<term>.+)$", re.IGNORECASE)
PREREQ_RE = re.compile(r"^Prerequisite:\s*(?P<text>.+)$", re.IGNORECASE)
RECOMMENDED_RE = re.compile(r"^Recommended:\s*(?P<text>.+)$", re.IGNORECASE)
COREQ_RE = re.compile(r"^Corequisite:\s*(?P<text>.+)$", re.IGNORECASE)


@dataclass
class Course:
    subject: str = ""
    number: str = ""
    title: str = ""
    units: str = ""
    term: str = ""
    prerequisite: str = ""
    recommended: str = ""
    corequisite: str = ""
    description: str = ""


def parse_courses(lines: List[str]) -> List[Course]:
    courses: List[Course] = []
    current: Optional[Course] = None
    desc_lines: List[str] = []

    def flush_current():
        if current is not None:
            current.description = " ".join(s.strip() for s in desc_lines).strip()
            courses.append(current)

    for raw in lines:
        line = raw.strip()
        if not line:
            # keep paragraph breaks within description by adding a space later
            if desc_lines and desc_lines[-1] != "":
                desc_lines.append("")
            continue

        m = COURSE_HEADER_RE.match(line)
        if m:
            # starting a new course
            flush_current()
            current = Course(
                subject=m.group("subject").strip(),
                number=m.group("number").strip(),
                title=m.group("title").strip(),
            )
            desc_lines = []
            continue

        if current is None:
            # ignore preamble text until first header
            continue

        # parse structured single-line fields
        if (mu := UNITS_RE.match(line)):
            current.units = mu.group("units").strip()
            continue
        if (mt := TERM_RE.match(line)):
            current.term = mt.group("term").strip()
            continue
        if (mp := PREREQ_RE.match(line)):
            # concatenate if repeated
            current.prerequisite = (current.prerequisite + " " + mp.group("text").strip()).strip()
            continue
        if (mr := RECOMMENDED_RE.match(line)):
            current.recommended = (current.recommended + " " + mr.group("text").strip()).strip()
            continue
        if (mc := COREQ_RE.match(line)):
            current.corequisite = (current.corequisite + " " + mc.group("text").strip()).strip()
            continue

        # otherwise, part of description
        desc_lines.append(line)

    # flush last
    flush_current()
    return courses


def main():
    text: str
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    lines = text.splitlines()
    courses = parse_courses(lines)

    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=[
            "subject",
            "number",
            "title",
            "units",
            "term",
            "prerequisite",
            "recommended",
            "corequisite",
            "description",
        ],
    )
    writer.writeheader()
    for c in courses:
        writer.writerow(asdict(c))


if __name__ == "__main__":
    main() 