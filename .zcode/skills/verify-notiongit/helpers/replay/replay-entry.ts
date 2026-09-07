// Local-only replay scaffolding (verify-notiongit). Wraps the real worker and
// rewrites every inbound request URL to the production origin, so the
// worker's redirect_uri computation (callbackUrl(request)) matches the
// redirect_uri a real GitHub authorization was minted with. Never deploy.
import worker from '../../../../../src/index';

const ORIGIN = 'https://inkdrafts.com';

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const inbound = new URL(request.url);
    const rewritten = new URL(`${ORIGIN}${inbound.pathname}${inbound.search}`);
    return (worker as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> }).fetch(
      new Request(rewritten, request), env, ctx,
    );
  },
};
