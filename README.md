# Switchboard

## Run from a clean clone

1. Install Node.js 22 or newer and Docker with Compose.
2. Run `npm run scaffold:install` to install the scaffold dependencies.
3. Run `npm run up` to start MongoDB, Redis, and the supplied simulators. With local MongoDB and Redis, run `npm run mocks` instead.
4. Run `npm run start:server`. The app defaults to port 4000 and reads configuration from the environment. See `.env.example` for the supported settings.
5. In another terminal, run `npm run inbound` to have a simulated customer send a signed message.

## Run the checker

Stop the app before running `npm run check` for Level 1. The checker starts its own server and clears application data. Use a dedicated local database.

Run `npm run check -- --levels 2` or `npm run check:full` under Linux with Linux Node and the services reachable from that environment. WSL is also suitable with Linux Node and dependencies installed inside WSL. The checker uses POSIX process-group signals for restart and cleanup. On native Windows, an instance may survive the check and keep port 4001 occupied. Confirm the process is the old Switchboard instance before stopping it.
