/**
 * The single failure taxonomy for the onboarding pipeline.
 *
 * Caller rules:
 * - Throw what the provider module already throws; never build descriptors at
 *   throw sites. Error classes carry only codes, never bodies, messages,
 *   tokens, ids, or URLs.
 * - Persist only `{ code, retryable }` in the durable record; all user copy
 *   and support metadata is derived at read time from this module and lives
 *   nowhere else.
 * - Throw sites that can derive their code do so (see `GithubAppAuthError`).
 *   A transport class that cannot carries only its status and is mapped by
 *   the surface that owns it.
 * - At an HTTP route, emit through `callbackFailure` and build the response
 *   at the wire boundary; this module never sees `Response`.
 *
 * Adding a failure: add the code to one stage tuple and one entry to that
 * stage's registry. The compiler then refuses to build until the entry states
 * its HTTP status, retryability, recovery, user copy, and support note.
 */

export const FLOW_FAILURE_CODES = [
  'invalid_job_id',
] as const;

export const NOTION_FAILURE_CODES = [
  'notion_configuration_missing',
  'notion_state_missing',
  'notion_state_invalid',
  'notion_state_expired',
  'notion_state_replayed',
  'notion_authorization_denied',
  'notion_code_missing',
  'notion_authorization_failed',
  'notion_rate_limited',
  'notion_unavailable',
  'notion_token_invalid',
  'notion_template_not_duplicated',
  'notion_template_root_invalid',
  'notion_template_root_unavailable',
  'notion_template_root_unshared',
  'notion_template_root_empty',
  'notion_template_database_missing',
  'notion_template_database_ambiguous',
  'notion_template_schema_invalid',
  'notion_template_unavailable',
  'notion_template_not_validated',
  'provisioning_job_missing',
  'provisioning_handoff_failed',
] as const;

export const GITHUB_FAILURE_CODES = [
  'github_configuration_missing',
  'github_state_missing',
  'github_state_invalid',
  'github_state_expired',
  'github_state_replayed',
  'github_authorization_denied',
  'github_authorization_failed',
  'github_installation_missing',
  'github_identity_missing',
  'github_setup_invalid',
  'github_authorization_unavailable',
  'github_installation_suspended',
  'github_organization_installation_not_supported',
  'github_account_mismatch',
  'github_provisioning_already_active',
  'github_rate_limited',
  'github_app_unavailable',
  'github_app_auth_failed',
] as const;

export const GENERATE_FAILURE_CODES = [
  'github_generate_rate_limited',
  'github_generate_timeout',
  'github_generate_name_exhausted',
  'github_generate_unavailable',
  'github_generate_branch_mismatch',
] as const;

export const PROVISION_FAILURE_CODES = [
  // config patch
  'github_config_unavailable',
  'github_config_conflict',
  'github_config_rate_limited',
  'github_config_invalid',
  // pages
  'github_pages_missing_branch',
  'github_pages_validation_failed',
  'github_pages_permission_denied',
  'github_pages_rate_limited',
  'github_pages_unavailable',
  // notion sync workflow
  'github_sync_dispatch_unavailable',
  'github_sync_permission_denied',
  'github_sync_rate_limited',
  'github_sync_correlate_timeout',
  'github_sync_run_timeout',
  'github_sync_run_failed',
  'github_sync_unavailable',
  // deployment verification
  'github_deploy_build_failed',
  'github_deploy_timeout',
  'github_deploy_unavailable',
  'github_deploy_url_unreachable',
  // actions secrets (the step is not yet wired into the pipeline)
  'github_actions_public_key_unavailable',
  'github_actions_public_key_invalid',
  'github_actions_secret_write_failed',
  // the provisioning machine itself
  'provisioning_step_failed',
  'provisioning_enqueue_failed',
  'github_provisioning_superseded',
] as const;

export type FlowFailureCode = (typeof FLOW_FAILURE_CODES)[number];
export type NotionFailureCode = (typeof NOTION_FAILURE_CODES)[number];
export type GithubFailureCode = (typeof GITHUB_FAILURE_CODES)[number];
export type GenerateFailureCode = (typeof GENERATE_FAILURE_CODES)[number];
export type ProvisionFailureCode = (typeof PROVISION_FAILURE_CODES)[number];

/** The one closed code union. No free-form error string crosses a boundary. */
export type ProvisioningFailureCode =
  | FlowFailureCode
  | NotionFailureCode
  | GithubFailureCode
  | GenerateFailureCode
  | ProvisionFailureCode;

export type SupportArea = 'notion' | 'github' | 'platform';

export interface UserCopy {
  readonly message: string;
  readonly action: string;
}

export interface SupportNote {
  readonly area: SupportArea;
  readonly note: string;
}

/**
 * `recovery` answers "what happens next" for whichever machine is listening.
 * In the queue, `retry_step` re-runs the step from `nextPendingStep()`. On a
 * callback surface no machine sits behind the failure, so terminal codes tell
 * the user how to proceed: restart the flow, perform a concrete action first,
 * or contact support.
 */
export type FailureRecovery =
  | 'retry_step'
  | 'restart_flow'
  | { readonly kind: 'user_action'; readonly action: string }
  | 'contact_support';

/**
 * A code is machine-retryable if and only if its recovery is `retry_step`;
 * the discriminated union makes every other pairing unrepresentable.
 */
export type FailureDescriptor =
  | {
      readonly retryable: true;
      readonly recovery: 'retry_step';
      readonly httpStatus: number;
      readonly user: UserCopy;
      readonly support: SupportNote;
    }
  | {
      readonly retryable: false;
      readonly recovery: Exclude<FailureRecovery, 'retry_step'>;
      readonly httpStatus: number;
      readonly user: UserCopy;
      readonly support: SupportNote;
    };

const FLOW_FAILURES: { [C in FlowFailureCode]: FailureDescriptor } = {
  invalid_job_id: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This connection link is not valid.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'platform', note: 'Job id failed the format check before any provider call.' },
  },
};

const NOTION_FAILURES: { [C in NotionFailureCode]: FailureDescriptor } = {
  notion_configuration_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 500,
    user: {
      message: 'We cannot start the Notion connection right now because our own setup is incomplete.',
      action: 'Wait a few minutes and try again. If it keeps happening, contact support.',
    },
    support: { area: 'notion', note: 'Preflight found Notion client id, client secret, or jobs KV unset.' },
  },
  notion_state_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'We could not match this Notion reply to a connection request.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'notion', note: 'Callback arrived without a state parameter.' },
  },
  notion_state_invalid: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This Notion connection link has been altered or does not match our records.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'notion', note: 'State signature or cookie check failed; stored state missing or mismatched.' },
  },
  notion_state_expired: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This Notion connection link has expired.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'notion', note: 'State was past its signed expiry when the callback arrived.' },
  },
  notion_state_replayed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This Notion connection link was already used.',
      action: 'Start again from the dashboard if you still need to connect.',
    },
    support: { area: 'notion', note: 'Replay marker hit; state was consumed by an earlier callback.' },
  },
  notion_authorization_denied: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'The Notion connection was not approved.',
      action: 'Start again and choose Allow when Notion asks for access.',
    },
    support: { area: 'notion', note: 'Notion redirected back with an error parameter; no token exchange attempted.' },
  },
  notion_code_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'Notion sent us back without the approval we need.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'notion', note: 'Callback carried neither a code nor an error parameter.' },
  },
  notion_authorization_failed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'Notion refused our request to connect your workspace.',
      action: 'Start again from the dashboard. If it keeps failing, contact support.',
    },
    support: { area: 'notion', note: 'Token exchange rejected by Notion with 400 or 401; credentials never echoed.' },
  },
  notion_rate_limited: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 429,
    user: {
      message: 'Notion is temporarily limiting connection requests.',
      action: 'Wait a minute, then start again from the dashboard.',
    },
    support: { area: 'notion', note: 'Notion token endpoint returned 429 during code exchange.' },
  },
  notion_unavailable: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'We could not reach Notion to finish connecting your workspace.',
      action: 'Try again in a few minutes. If it still does not work, contact support.',
    },
    support: { area: 'notion', note: 'Fallback for uncoded Notion callback failures; no provider detail retained.' },
  },
  notion_token_invalid: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'Notion\u2019s reply about your connection was incomplete, so we stopped safely.',
      action: 'Start again from the dashboard. If it happens again, contact support.',
    },
    support: { area: 'notion', note: 'Token response was missing fields this connection requires.' },
  },
  notion_template_not_duplicated: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'duplicate_template_then_reconnect' },
    httpStatus: 400,
    user: {
      message: 'Your Notion workspace does not have a copy of the InkDrafts template yet.',
      action: 'Duplicate the InkDrafts template in Notion, then connect again.',
    },
    support: { area: 'notion', note: 'Authorization carried no duplicated template reference; programmatic creation is deliberately unimplemented.' },
  },
  notion_template_root_invalid: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'The reference to your duplicated Notion template does not look right.',
      action: 'Duplicate the template again in Notion, then connect again.',
    },
    support: { area: 'notion', note: 'Duplicated template reference failed normalization before any call.' },
  },
  notion_template_root_unavailable: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'We could not open your duplicated Notion template yet.',
      action: 'Wait a moment, then connect again. If it keeps failing, contact support.',
    },
    support: { area: 'notion', note: 'Template root children still not visible after all retry attempts; usually propagation.' },
  },
  notion_template_root_unshared: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'reshare_page_then_reconnect' },
    httpStatus: 403,
    user: {
      message: 'InkDrafts is not allowed to open your duplicated Notion template.',
      action: 'Make sure the template page is shared with InkDrafts in Notion, then connect again.',
    },
    support: { area: 'notion', note: 'Template root read returned 403 right after duplication; connection lacks access to the page, or access was revoked.' },
  },
  notion_template_root_empty: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'Your duplicated Notion template opened, but its content is not showing yet.',
      action: 'Wait a moment, then connect again. If it still looks empty, contact support.',
    },
    support: { area: 'notion', note: 'Root was reachable but showed no child databases after all retry attempts.' },
  },
  notion_template_database_missing: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 422,
    user: {
      message: 'Your duplicated Notion template is missing a database we expect.',
      action: 'Contact support so we can help you restore the template.',
    },
    support: { area: 'notion', note: 'Every child database was fetched and identified; one role had no match.' },
  },
  notion_template_database_ambiguous: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 422,
    user: {
      message: 'Your duplicated Notion template has unclear duplicate databases, so we stopped rather than guess.',
      action: 'Contact support so we can help you fix the template.',
    },
    support: { area: 'notion', note: 'A role matched multiple databases or one database matched multiple roles; never guessed between.' },
  },
  notion_template_schema_invalid: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'restore_template_databases_then_reconnect' },
    httpStatus: 422,
    user: {
      message: 'The databases in your duplicated Notion template do not have the columns InkDrafts needs.',
      action: 'Restore the template\u2019s databases in Notion, then connect again.',
    },
    support: { area: 'notion', note: 'Database shape validation failed after fetch; non-secret remediation details are attached to the response body.' },
  },
  notion_template_unavailable: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'Some parts of your duplicated Notion template could not be read in time.',
      action: 'Wait a moment, then connect again. If it keeps failing, contact support.',
    },
    support: { area: 'notion', note: 'Found databases kept failing to fetch within the request\u2019s retry budget.' },
  },
  notion_template_not_validated: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'complete_notion_check_then_connect_github' },
    httpStatus: 400,
    user: {
      message: 'Your Notion databases have not finished their compatibility check yet.',
      action: 'Connect Notion first and complete the Pages and Posts check, then connect GitHub.',
    },
    support: { area: 'notion', note: 'Preflight gate: no stored template resolution, or a schema version mismatch, for this job.' },
  },
  provisioning_job_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 409,
    user: {
      message: 'We could not find a site setup in progress for this link.',
      action: 'Start again from the beginning: connect GitHub first, then Notion.',
    },
    support: { area: 'platform', note: 'Job id unknown, expired, or missing at a route that requires a live job; the response attaches the connect URL.' },
  },
  provisioning_handoff_failed: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'reconnect_notion_to_retry_handoff' },
    httpStatus: 502,
    user: {
      message: 'Your site\u2019s setup is almost ready, but we could not hand it to the background queue.',
      action: 'Connect Notion again for the same site. The next pass picks up where this one stopped.',
    },
    support: { area: 'platform', note: 'Actions secrets are written durably; the queue send failed after them. The job record carries the provisioning_enqueue_failed breadcrumb, and the response attaches the retry URL. Re-authorizing Notion skips straight to the handoff.' },
  },
};

const GITHUB_FAILURES: { [C in GithubFailureCode]: FailureDescriptor } = {
  github_configuration_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 500,
    user: {
      message: 'We cannot start the GitHub connection right now because our own setup is incomplete.',
      action: 'Wait a few minutes and try again. If it keeps happening, contact support.',
    },
    support: { area: 'github', note: 'Preflight found GitHub app id, client id, client secret, jobs KV, or queue unset.' },
  },
  github_state_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'We could not match this GitHub reply to a connection request.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'github', note: 'Callback arrived without a state parameter.' },
  },
  github_state_invalid: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This GitHub connection link has been altered or does not match our records.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'github', note: 'State signature check failed, or stored state missing or mismatched.' },
  },
  github_state_expired: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This GitHub connection link has expired.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'github', note: 'State was past its signed expiry at callback time.' },
  },
  github_state_replayed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'This GitHub connection link was already used.',
      action: 'Start again from the dashboard if you still need to connect.',
    },
    support: { area: 'github', note: 'Replay marker hit; state phase consumed by an earlier callback.' },
  },
  github_authorization_denied: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'The GitHub connection was not approved.',
      action: 'Start again and approve access when GitHub asks.',
    },
    support: { area: 'github', note: 'Callback carried an error parameter; no token exchange attempted.' },
  },
  github_authorization_failed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'GitHub refused our request to sign you in.',
      action: 'Start again from the dashboard. If it keeps failing, contact support.',
    },
    support: { area: 'github', note: 'Code exchange or identity call rejected by GitHub with 400 or 401.' },
  },
  github_installation_missing: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'install_app_then_connect_again' },
    httpStatus: 400,
    user: {
      message: 'We could not find the InkDrafts app installed on your GitHub account.',
      action: 'Install the InkDrafts GitHub app for your account, then connect again.',
    },
    support: { area: 'github', note: 'No installation reference in the callback and none findable for this app, or the installation lookup returned 404.' },
  },
  github_identity_missing: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'We could not confirm your GitHub account details before starting setup.',
      action: 'Start again from the dashboard. If it happens again, contact support.',
    },
    support: { area: 'github', note: 'Defensive branch: identity was not established after the installation checks.' },
  },
  github_setup_invalid: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 400,
    user: {
      message: 'GitHub sent an unexpected setup reply for this connection.',
      action: 'Start again from the dashboard to get a fresh link.',
    },
    support: { area: 'github', note: 'setup_action parameter present but not install or update.' },
  },
  github_authorization_unavailable: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'We hit a problem talking to GitHub while connecting your account.',
      action: 'Try again in a few minutes. If it still does not work, contact support.',
    },
    support: { area: 'github', note: 'Fallback for uncoded GitHub callback failures; no provider detail retained.' },
  },
  github_installation_suspended: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'unblock_installation_then_connect_again' },
    httpStatus: 403,
    user: {
      message: 'The InkDrafts app on your GitHub account is currently blocked.',
      action: 'Unblock the InkDrafts app in your GitHub settings, then connect again.',
    },
    support: { area: 'github', note: 'Installation reported a suspension marker at the usability check.' },
  },
  github_organization_installation_not_supported: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'connect_personal_account' },
    httpStatus: 403,
    user: {
      message: 'InkDrafts currently works with personal GitHub accounts, and this connection points at an organization.',
      action: 'Connect with the personal GitHub account that has the InkDrafts app installed.',
    },
    support: { area: 'github', note: 'Installation account type or authenticated user type is Organization.' },
  },
  github_account_mismatch: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'sign_in_with_matching_account' },
    httpStatus: 403,
    user: {
      message: 'The GitHub account you signed in with is not the one that has the InkDrafts app installed.',
      action: 'Sign in with the GitHub account where you installed InkDrafts, then connect again.',
    },
    support: { area: 'github', note: 'Installation account does not match the authenticated user\u2019s account.' },
  },
  github_provisioning_already_active: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'wait_for_current_setup_then_retry' },
    httpStatus: 409,
    user: {
      message: 'A site setup is already running for your account.',
      action: 'Wait for it to finish. If you need to start over, wait a few minutes first.',
    },
    support: { area: 'platform', note: 'Start gate refused as account_busy: one provisioning per account is already in flight. The response status and Retry-After come from the gate error; the registry status is the canonical mapping.' },
  },
  github_rate_limited: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 429,
    user: {
      message: 'GitHub is temporarily limiting requests while we set up your site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, start again later.',
    },
    support: { area: 'github', note: 'GitHub 429 on identity, installation, code exchange, or app-auth calls.' },
  },
  github_app_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We could not reach GitHub\u2019s app services to continue setting up your site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, start again later.',
    },
    support: { area: 'github', note: 'App JWT or installation-token endpoint returned a 5xx status.' },
  },
  github_app_auth_failed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'GitHub rejected our app\u2019s request to act on your account.',
      action: 'Connect your GitHub account again. If it keeps failing, contact support.',
    },
    support: { area: 'github', note: 'App JWT or installation-token endpoint returned a 4xx status, including the revoked-installation 404 on token mint.' },
  },
};

const GENERATE_FAILURES: { [C in GenerateFailureCode]: FailureDescriptor } = {
  github_generate_rate_limited: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 429,
    user: {
      message: 'GitHub is temporarily limiting how fast we can create your site\u2019s repository.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, start again later.',
    },
    support: { area: 'github', note: 'Template generate call rate-limited; Retry-After honored when present.' },
  },
  github_generate_timeout: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 504,
    user: {
      message: 'Your new site\u2019s repository is taking longer than expected to become ready.',
      action: 'We\u2019ll keep checking automatically. If setup does not finish, start again later.',
    },
    support: { area: 'github', note: 'Generated repository never reported a readable main commit within the poll budget.' },
  },
  github_generate_name_exhausted: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 409,
    user: {
      message: 'We could not find a free name for your new site\u2019s repository.',
      action: 'Contact support and we\u2019ll help you get set up.',
    },
    support: { area: 'github', note: 'Every deterministic repository-name candidate was refused as taken.' },
  },
  github_generate_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We hit a problem while creating your new site\u2019s repository.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, start again later.',
    },
    support: { area: 'github', note: 'Generate or reuse path returned an unusable response.' },
  },
  github_generate_branch_mismatch: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'remove_existing_repository_then_restart' },
    httpStatus: 502,
    user: {
      message: 'The repository created for your site cannot be used safely.',
      action: 'Remove or rename that repository in your GitHub account, then start again.',
    },
    support: { area: 'github', note: 'Generated repository reports fork true, so it can never become the site source.' },
  },
};

const PROVISION_FAILURES: { [C in ProvisionFailureCode]: FailureDescriptor } = {
  github_config_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We could not read your new site\u2019s settings file to prepare it.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Config file read or write failed transiently on the generated repository.' },
  },
  github_config_conflict: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 409,
    user: {
      message: 'Your site\u2019s settings file changed at the same moment we updated it.',
      action: 'We\u2019ll retry automatically with the latest version.',
    },
    support: { area: 'github', note: 'Config write rejected as a conflict; the retry re-reads and re-applies.' },
  },
  github_config_rate_limited: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 429,
    user: {
      message: 'GitHub is temporarily limiting requests while preparing your site\u2019s settings.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Config read or write rate-limited (including 403 with Retry-After); Retry-After is honored and rides the fresh-message transport.' },
  },
  github_config_invalid: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 502,
    user: {
      message: 'Your site\u2019s settings file could not be understood, so we stopped rather than damage it.',
      action: 'Contact support so we can repair the setup.',
    },
    support: { area: 'github', note: 'Config parse or shape check failed; retrying cannot repair the content.' },
  },
  github_pages_missing_branch: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 404,
    user: {
      message: 'GitHub cannot find the main branch your site publishes from.',
      action: 'Contact support so we can repair the setup.',
    },
    support: { area: 'github', note: 'Pages or repository lookup returned 404 for the expected branch.' },
  },
  github_pages_validation_failed: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 422,
    user: {
      message: 'GitHub rejected your site\u2019s publishing settings.',
      action: 'Contact support so we can fix the setup.',
    },
    support: { area: 'github', note: 'Pages create call refused as a bad request; build settings rejected.' },
  },
  github_pages_permission_denied: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 403,
    user: {
      message: 'GitHub says InkDrafts no longer has permission to publish your site.',
      action: 'Connect your GitHub account again to restore access. If it keeps failing, contact support.',
    },
    support: { area: 'github', note: 'Pages call returned 401 or 403; installation access likely revoked mid-flow.' },
  },
  github_pages_rate_limited: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 429,
    user: {
      message: 'GitHub is temporarily limiting publishing requests for your site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Pages create or status calls rate-limited; Retry-After honored when present.' },
  },
  github_pages_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We hit a problem turning on publishing for your new site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Pages create or status calls failed transiently or returned unusable bodies.' },
  },
  github_sync_dispatch_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We could not start the step that copies your Notion content into the new site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Workflow dispatch failed before GitHub confirmed it; the recorded marker makes the retry correlate, not re-dispatch.' },
  },
  github_sync_permission_denied: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 403,
    user: {
      message: 'GitHub says InkDrafts no longer has permission to run the content sync.',
      action: 'Connect your GitHub account again to restore access. If it keeps failing, contact support.',
    },
    support: { area: 'github', note: 'Dispatch call returned 401; installation access likely revoked.' },
  },
  github_sync_rate_limited: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 429,
    user: {
      message: 'GitHub is temporarily limiting the content-sync requests for your site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Dispatch or run-list calls rate-limited; Retry-After honored when present.' },
  },
  github_sync_correlate_timeout: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 504,
    user: {
      message: 'We started copying your Notion content but have not confirmed the copy started yet.',
      action: 'We\u2019ll keep checking automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Correlation window found no dispatched run before giving up; the dispatch marker makes the retry resume safely.' },
  },
  github_sync_run_timeout: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 504,
    user: {
      message: 'Copying your Notion content is taking longer than expected.',
      action: 'We\u2019ll keep checking automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Dispatched run stayed unfinished through the poll budget.' },
  },
  github_sync_run_failed: {
    retryable: false,
    recovery: 'restart_flow',
    httpStatus: 502,
    user: {
      message: 'The step that copies your Notion content into the new site ran and reported failure.',
      action: 'Start again to run a fresh copy. If it fails the same way, contact support.',
    },
    support: { area: 'github', note: 'Run concluded as failed; terminal because a retry would re-await the same concluded run, and a content fix needs a fresh flow to trigger a new sync.' },
  },
  github_sync_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We hit a problem while copying your Notion content into the new site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Run-list or run reads failed transiently or returned unusable bodies.' },
  },
  github_deploy_build_failed: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 502,
    user: {
      message: 'GitHub tried to build your site and reported that the build failed.',
      action: 'Contact support so we can look into the build.',
    },
    support: { area: 'github', note: 'Pages build reported errored for this exact commit; a rebuild cannot fix a content-errored build.' },
  },
  github_deploy_timeout: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 504,
    user: {
      message: 'Your site\u2019s build is taking longer than expected.',
      action: 'We\u2019ll keep checking automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Build stayed unfinished through the poll budget.' },
  },
  github_deploy_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We hit a problem while building your new site.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Head or build reads failed transiently or returned unusable bodies.' },
  },
  github_deploy_url_unreachable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 504,
    user: {
      message: 'We built your site but could not reach its address to confirm it is live.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Site verify fetch kept failing after the build reported done.' },
  },
  github_actions_public_key_unavailable: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We could not get the key needed to store your site\u2019s secrets securely.',
      action: 'We\u2019ll keep trying automatically. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Actions public-key read failed transiently; step not yet wired into the pipeline.' },
  },
  github_actions_public_key_invalid: {
    retryable: false,
    recovery: 'contact_support',
    httpStatus: 502,
    user: {
      message: 'The key for storing your site\u2019s secrets looked wrong, so we stopped safely.',
      action: 'Contact support so we can repair the setup.',
    },
    support: { area: 'github', note: 'Public-key shape was invalid; provisioning cannot proceed safely.' },
  },
  github_actions_secret_write_failed: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'We could not store one of your site\u2019s secrets.',
      action: 'We\u2019ll keep trying automatically; storing is safe to repeat. If setup does not finish, contact support.',
    },
    support: { area: 'github', note: 'Secret write failed; the write is idempotent.' },
  },
  provisioning_step_failed: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'Something went wrong on our side while setting up your site.',
      action: 'We\u2019ll retry automatically. If it does not finish, contact support.',
    },
    support: { area: 'platform', note: 'Unclassified throw inside a step; bounded by the per-step attempt ceiling.' },
  },
  provisioning_enqueue_failed: {
    retryable: true,
    recovery: 'retry_step',
    httpStatus: 502,
    user: {
      message: 'Your site\u2019s setup is still in progress.',
      action: 'This step is taking longer than usual. Check back shortly; if it does not finish, contact support.',
    },
    support: {
      area: 'platform',
      note: 'Queue send failed. Mid-pipeline this breadcrumb is retryable by design. At initial enqueue the record is written with retryable false and the job is dead-lettered, because no message stream exists to redeliver it: the registry value is the default policy, the record is the decision snapshot.',
    },
  },
  github_provisioning_superseded: {
    retryable: false,
    recovery: { kind: 'user_action', action: 'continue_with_latest_setup' },
    httpStatus: 409,
    user: {
      message: 'A newer setup request for your account replaced this one, so the older attempt was stopped.',
      action: 'Nothing to fix here. Keep going with your latest setup.',
    },
    support: { area: 'platform', note: 'Gate detected a newer provisioning run for the same account; this job is terminated as status failed (distinct from provider dead_letter) so the newer run owns the account.' },
  },
};

export const FAILURE_REGISTRY: { [C in ProvisioningFailureCode]: FailureDescriptor } = {
  ...FLOW_FAILURES,
  ...NOTION_FAILURES,
  ...GITHUB_FAILURES,
  ...GENERATE_FAILURES,
  ...PROVISION_FAILURES,
};

export type FailureStage = 'flow' | 'notion' | 'github' | 'generate' | 'provision';

/** Runtime membership guard. The boundary validator for anything read back from KV, a queue payload, or a request. */
export function isProvisioningFailureCode(value: unknown): value is ProvisioningFailureCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_REGISTRY, value);
}

/** Static metadata for a known code. Cannot fail: the union guarantees the key. */
export function failureDescriptor(code: ProvisioningFailureCode): FailureDescriptor {
  return FAILURE_REGISTRY[code];
}

export function userCopy(code: ProvisioningFailureCode): UserCopy {
  return FAILURE_REGISTRY[code].user;
}

export function failureStage(code: ProvisioningFailureCode): FailureStage {
  if (code in FLOW_FAILURES) return 'flow';
  if (code in NOTION_FAILURES) return 'notion';
  if (code in GITHUB_FAILURES) return 'github';
  if (code in GENERATE_FAILURES) return 'generate';
  return 'provision';
}

/** Support-facing view of a recorded code: registry metadata joined with the correlation id the caller supplies. */
export function failureSupport(code: ProvisioningFailureCode, jobId: string): {
  code: ProvisioningFailureCode;
  stage: FailureStage;
  area: SupportArea;
  jobId: string;
  note: string;
} {
  const descriptor = FAILURE_REGISTRY[code];
  return { code, stage: failureStage(code), area: descriptor.support.area, jobId, note: descriptor.support.note };
}

/** Redacted diagnostic cause: the code and the provider status class only. No bodies, messages, or URLs. */
export function failureCause(error: unknown): {
  code: ProvisioningFailureCode | null;
  providerStatus: number | null;
} {
  const code = codedFailureCode(error);
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return {
    code,
    providerStatus: typeof status === 'number' ? status : null,
  };
}

/**
 * Thrown by code-only flow checks (account mismatch, suspended installation,
 * unsupported organization) so every failure crossing a mapper carries its
 * code as data instead of as an Error message.
 */
export class FlowFailure extends Error {
  readonly code: ProvisioningFailureCode;

  constructor(code: ProvisioningFailureCode) {
    super(code);
    this.name = 'FlowFailure';
    this.code = code;
  }
}

export interface ProvisioningErrorClassification {
  code: ProvisioningFailureCode;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

export function codedFailureCode(error: unknown): ProvisioningFailureCode | null {
  const candidate = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return isProvisioningFailureCode(candidate) ? candidate : null;
}

function errorRetryAfterSeconds(error: unknown): number | null {
  const value = (error as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
  return typeof value === 'number' ? value : null;
}

/** Maps every provisioning error this queue can encounter to a retry decision. */
export function classifyProvisioningError(error: unknown): ProvisioningErrorClassification {
  // An unrecognized error (a network throw, a bug) is treated as transient.
  // The per-step attempt ceiling still bounds it to a handful of tries before
  // the job goes to dead_letter, so this can never retry forever.
  const code = codedFailureCode(error) ?? 'provisioning_step_failed';
  return {
    code,
    retryable: FAILURE_REGISTRY[code].retryable,
    retryAfterSeconds: errorRetryAfterSeconds(error),
  };
}

export type CallbackFailureContext = 'github' | 'notion';

export interface CallbackFailure {
  code: ProvisioningFailureCode;
  status: number;
  retryAfterSeconds: number | null;
  details: Record<string, unknown> | null;
}

const CALLBACK_FALLBACKS: Record<CallbackFailureContext, ProvisioningFailureCode> = {
  github: 'github_authorization_unavailable',
  notion: 'notion_unavailable',
};

/**
 * Callback-time failure resolved to the domain data a route needs to build
 * today's exact response bytes. Uncoded errors fall back per context: GitHub
 * to `github_authorization_unavailable`, Notion to `notion_unavailable`.
 */
export function callbackFailure(error: unknown, context: CallbackFailureContext): CallbackFailure {
  const code = codedFailureCode(error);
  const resolved = code ?? CALLBACK_FALLBACKS[context];
  const descriptor = FAILURE_REGISTRY[resolved];
  const details = code === null ? null : (error as { details?: unknown }).details;
  return {
    code: resolved,
    status: descriptor.httpStatus,
    retryAfterSeconds: errorRetryAfterSeconds(error),
    details: typeof details === 'object' && details !== null ? details as Record<string, unknown> : null,
  };
}
