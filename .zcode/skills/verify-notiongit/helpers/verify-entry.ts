// Verification scaffolding, shipped by .zcode/skills/verify-notiongit.
// workerd requires every export of the Worker main module to be a handler,
// but src/index.ts re-exports test-facing barrel names (e.g. the string
// constant ACCOUNT_LEASE_PREFIX), which crashes `wrangler dev` at startup
// with "Incorrect type for map entry 'ACCOUNT_LEASE_PREFIX'". This entry
// serves only the default ExportedHandler so the real worker starts locally.
import worker from '../../../../src/index';

export default worker;
