'use strict';
// A sign-in button can coexist with a working guest composer. A login page cannot.
function composer(site, state) {
  if (!state?.composer || state.challenge) return false;
  try {
    const url=new URL(state.url);
    if(site==='gpt')return url.origin==='https://chatgpt.com' && /^(?:\/|\/(?:g\/[^/]+\/)?c\/[^/]+\/?)$/.test(url.pathname);
    if(site==='gemini')return url.origin==='https://gemini.google.com' && /^\/app(?:\/[^/]+)?\/?$/.test(url.pathname);
  } catch {}
  return false;
}
module.exports={composer};
