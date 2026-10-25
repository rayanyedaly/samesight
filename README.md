# Samesight

Your database and your devices see the same rows. Samesight lets a Supabase team write who-can-see-what once in a typed TypeScript policy file, generates both the Postgres row-level security and the PowerSync sync config from it, and proves with automated tests, against a real local Supabase stack and PowerSync service, that no device ever receives a row the database would refuse to show that user. Work in progress, not yet usable; MIT licensed.
