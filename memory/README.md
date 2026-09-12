# Pi shared memory

Local-only folder (git-ignored) mounted into the pi-sandbox container at
`/home/pi/memory`. See `PROTOCOL.md` for the format.

- `MEMORY.md` — durable facts (env, conventions, pitfalls)
- `log/YYYY-MM-DD.md` — append-only session log
- `pi-mem.sh` — helper (`show` / `note` / `log` / `fact`)
