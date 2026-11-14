// One entry point for every model call. Model ids that start with `ollama:` run on the local Ollama
// server; everything else goes to GMI Cloud. A room can mix both.
import { config } from './config.js';
import { chat as chatGmi, listModels as listGmi, probeModel as probeGmi, GmiError } from './gmi.js';
import { chatLocal, listLocalModels, probeLocal, isLocal, localName, ollamaEnabled, LOCAL_PREFIX } from './ollama.js';

export { GmiError, isLocal, localName, LOCAL_PREFIX };

export const providerOf = (model) => (isLocal(model) ? 'ollama' : 'gmi');

/** Why a model cannot be called right now, or '' when it can. */
export function cannotCall(model) {
  if (isLocal(model)) return ollamaEnabled() ? '' : 'Local models are switched off (PANELSHOW_OLLAMA_URL=off).';
  return config.apiKey ? '' : `${model} runs on GMI Cloud, and GMI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.`;
}

export function chat(args) {
  return isLocal(args.model) ? chatLocal(args) : chatGmi(args);
}

export function probeModel(model, opts) {
  return isLocal(model) ? probeLocal(model, opts) : probeGmi(model, opts);
}

/**
 * Models from every provider that is set up: GMI (with a key) and Ollama (when it answers).
 * Throws only when nothing at all could be listed and something failed.
 */
export async function listModels({ refresh = false } = {}) {
  const [gmi, local] = await Promise.all([
    config.apiKey ? listGmi({ refresh }).then((models) => ({ models }), (e) => ({ models: [], error: e.message })) : { models: [] },
    listLocalModels({ refresh }),
  ]);
  const models = [...gmi.models.map((m) => ({ ...m, provider: 'gmi' })), ...local.models];
  if (!models.length && gmi.error) throw new GmiError(gmi.error);
  return models;
}

/** What is set up, for the page. */
export async function providers() {
  const local = await listLocalModels();
  return {
    gmi: { configured: Boolean(config.apiKey), baseUrl: config.baseUrl },
    ollama: { enabled: ollamaEnabled(), url: ollamaEnabled() ? config.ollamaUrl : '', reachable: local.reachable, models: local.models.length },
  };
}
