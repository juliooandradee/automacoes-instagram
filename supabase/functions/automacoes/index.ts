// Ponto de entrada no Supabase (Deno). A lógica fica em handler.mjs, testada no Node.
import { makeHandler } from './handler.mjs';

// O processamento depois do webhook continua em segundo plano, sem atrasar a resposta à Meta.
const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
const background = (promise: Promise<unknown>) => (runtime ? runtime.waitUntil(promise) : promise);

Deno.serve(makeHandler({ env: Deno.env.toObject(), background }));
