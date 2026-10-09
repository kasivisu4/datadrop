import { Duck } from './data/duck.js';
import { fetchGitHubFile, resolveRemoteFile } from './data/github.js';
import { createLLM } from './agents/llm.js';
import { createPipeline } from './agents/pipeline.js';
import { mountApp } from './ui/app.js';

const app = mountApp(document.getElementById('app'), { Duck, fetchGitHubFile, resolveRemoteFile, createLLM, createPipeline });
// ?debug exposes the app (state.duck, state.pipeline, loadUrl, ask) for agents and manual checks in DevTools.
if (new URLSearchParams(location.search).has('debug')) window.__datadrop = app;
