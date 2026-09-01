/**
 * InkDrafts' edge entrypoint.
 *
 * This file intentionally contains only the transport seam. OAuth and
 * provisioning handlers are added by the issues that build on this skeleton.
 */

export interface Env {
  /** Durable provisioning-job records. Values are JSON and have a short TTL. */
  JOBS: KVNamespace;
  /** Work queue for resumable provisioning jobs. */
  PROVISIONING_QUEUE: Queue<ProvisioningMessage>;
  /** Server-only secrets configured with `wrangler secret put`. */
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
}

export interface ProvisioningMessage {
  jobId: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function html(document: string, status = 200): Response {
  return new Response(document, { status, headers: HTML_HEADERS });
}

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InkDrafts</title></head>
  <body><main><h1>InkDrafts</h1><p>Notion-powered publishing for GitHub Pages.</p></main></body>
</html>`;

export function route(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    return html(LANDING_PAGE);
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return json({ ok: true, service: 'notiongit' });
  }

  if (
    (url.pathname === '/auth/notion/callback' ||
      url.pathname === '/auth/github/callback') &&
    request.method === 'GET'
  ) {
    return json({ error: 'not_implemented' }, 501);
  }

  return json(
    {
      error: 'not_found',
      message: 'The requested route does not exist.',
    },
    404,
  );
}

const worker: ExportedHandler<Env> = {
  fetch(request) {
    return route(request);
  },

  async queue(batch) {
    // The consumer is deliberately a seam until the durable job model lands.
    // Do not log message bodies: future messages may contain sensitive state.
    console.info('provisioning queue received a batch', {
      queue: batch.queue,
      messageCount: batch.messages.length,
    });

    for (const message of batch.messages) {
      message.retry();
    }
  },
};

export default worker;
