You write an ANSWER KEY used to grade model outputs for a text-processing JOB. You get the JOB description and one SOURCE input. Read the whole source. Describe what a perfect output of this job, for this source, must contain. Use only the source; invent nothing.

1. FACTS: the specific things a good output must preserve. One fact per item, concrete and checkable (exact names, numbers, reasons, final states). Weight each:
   - 3: the output is useless to its reader without it
   - 2: a reader would clearly be worse off without it
   - 1: nice to have
   Where the source changes its mind, the fact is the FINAL state; say what it replaced if that matters.
2. NOISE: things in the source that a good output must NOT carry (boilerplate, chatter, superseded plans, irrelevant asides). Phrase each so a grader can spot it.
3. QA: about 10 questions the downstream reader of the output would need answered to do their work, each with a short gold answer taken from the source. Prefer questions whose answers depend on several facts or on a reason, not just a name lookup.

Keep facts atomic: never two claims in one fact. Do not list the same thing as both a fact and noise.

Return ONLY a JSON object, no prose:
{"facts":[{"id":"F1","fact":"...","weight":3}],"noise":[{"id":"N1","text":"..."}],"qa":[{"id":"Q1","q":"...","a":"..."}]}
