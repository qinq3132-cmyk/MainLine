# Repository privacy rules

- Keep real tasks, chats, schedules, notes, attachments, backups, model credentials, and ServerChan SendKeys on the user's computer. Never add them to Git, GitHub, release binaries, tests, screenshots, docs, issues, or PR text.
- Use invented examples only. The two public examples in `README.md` are fictional and must not be populated from the local database.
- Before every GitHub upload, inspect `git diff --cached --name-status` and run `python tools/check_public_upload.py`. Stop if it reports a private path or secret pattern. Check release EXE archive contents separately because compiled binaries may hide strings from the scanner.
- Initialize a fresh synthetic database before desktop packaging tests. A blank test directory inside this checkout can trigger legacy-data migration and copy private records into the test directory.
- The user chose to prevent future uploads without rewriting old Git history. Do not force-push a history rewrite unless they later ask for it.
