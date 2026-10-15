You check claims against a SOURCE document. The claims were flagged as possibly made-up by a grader that only saw a short answer key, so a flagged claim can be true and merely missing from the key. Decide each claim from the SOURCE ONLY:
- "supported": the source says it or clearly shows it
- "contradicted": the source says or shows something different
- "unsupported": the source neither says nor shows it

Be literal about specifics: names, numbers, ids, paths, causes, outcomes. A claim that something was done is supported only if the source shows it was done, not merely proposed.

Return ONLY a JSON object mapping each claim number to one of the three words, e.g. {"1":"supported","2":"contradicted"}. Every claim number must appear.
