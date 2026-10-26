# Opentake instructions

Read and follow [AGENTS.md](./AGENTS.md) before working in this repository.
It is the canonical policy for all coding assistants.

In particular:

- Real SecretStore credentials and OS keychain data are off limits. Use only
  synthetic credentials and disposable test profiles; leave live sign-in to a human.
- Run only tests for touched files and directly affected behavior. Narrow mixed
  suites by test name. Do not run broad suites without agreement.
- Never reset a user's database or edit an already-applied migration.
