// Structural validation of a `POST /v1/oauth/token` response against the
// field shape documented at https://developers.notion.com/docs/authorization
// and https://developers.notion.com/reference/create-a-token. This does not
// call Notion — it validates a response object (real or fixture) so the
// provisioning backend can fail fast and loudly on an unexpected shape
// instead of reading `undefined` fields deep into a job.
//
// See docs/decisions/0002-notion-onboarding.md for which of these fields are
// confirmed against current Notion documentation vs. inferred.

const REQUIRED_STRING_FIELDS = ['access_token', 'token_type', 'bot_id', 'workspace_id'];

export function validateOAuthTokenResponse(response) {
  const problems = [];

  if (!response || typeof response !== 'object') {
    return { valid: false, problems: ['response is not an object'], hasDuplicatedTemplate: false };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof response[field] !== 'string' || response[field].length === 0) {
      problems.push(`missing or non-string required field: ${field}`);
    }
  }

  if (response.token_type !== undefined && response.token_type !== 'bearer') {
    problems.push(`unexpected token_type: ${JSON.stringify(response.token_type)} (expected "bearer")`);
  }

  if (response.owner !== undefined) {
    if (typeof response.owner !== 'object' || response.owner === null || typeof response.owner.type !== 'string') {
      problems.push('owner field is present but not an object with a string "type"');
    }
  }

  const hasDuplicatedTemplate =
    typeof response.duplicated_template_id === 'string' && response.duplicated_template_id.length > 0;

  // duplicated_template_id is documented as present only when the
  // integration has a template configured AND the user's consent-screen
  // flow duplicated it — its absence is not itself invalid, but a
  // provisioning flow that REQUIRES duplication must treat a missing/null
  // value as "duplication did not happen" and fall back (see ADR 0002),
  // never as a validation failure of the token response itself.
  if (response.duplicated_template_id !== undefined && response.duplicated_template_id !== null) {
    if (typeof response.duplicated_template_id !== 'string' || response.duplicated_template_id.length === 0) {
      problems.push('duplicated_template_id is present but not a non-empty string');
    }
  }

  return { valid: problems.length === 0, problems, hasDuplicatedTemplate };
}
