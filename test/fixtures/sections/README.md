# Public schedule parser fixtures

`results.html` and `detail.html` are sanitized public Cal Poly Class Search
responses retrieved on 2026-10-28 UTC with term `2268`, campus `MAIN`, subject `BIO`,
course `1111`, and **Show Open Classes Only = No**.

- Results: three sections, CRNs 6369 / 6370 / 6371.
- Detail: S01 / CRN 6369 / Haley Moniz, including the observed Follett materials link.

Source: https://cmsweb.pscs.calpoly.edu/psc/CSLOPRD/EMPLOYEE/SA/c/COMMUNITY_ACCESS.CLASS_SEARCH.GBL

Sanitization removes scripts, form inputs/values, session tokens and cookies. The
tests generate explicitly synthetic variations to exercise incorrect links, outages,
XML envelopes, and changing identities. These variations are never production data.
