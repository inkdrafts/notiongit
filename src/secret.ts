/**
 * Typed, self-redacting credential wrapper.
 *
 * Invariants:
 * - A Secret never yields its value to string coercion or JSON serialization;
 *   `toString()`, `toJSON()`, and template-literal interpolation all produce
 *   the marker "[redacted]". Unwrapping is an explicit, greppable `.raw` or
 *   `.bearer()` call at a provider-client boundary.
 * - Kinds are nominal and distinct: a Secret<'github-installation'> is not
 *   assignable to a Secret<'github-user-access'> slot, so tokens cannot be
 *   cross-fed between the write-through path and the mint-per-use path.
 * - A Secret holds at most one credential copy; it carries no metadata beyond
 *   its kind label, which exists for diagnostics, not for decisions.
 */

export type SecretKind =
  | 'notion-user-access'
  | 'github-user-access'
  | 'github-installation';

export const REDACTED = '[redacted]';

export class Secret<Kind extends SecretKind> {
  readonly kind: Kind;
  readonly #value: string;

  private constructor(kind: Kind, value: string) {
    this.kind = kind;
    this.#value = value;
  }

  /** Write-through token minted by the Notion callback; dies with that request. */
  static notionUserAccess(value: string): Secret<'notion-user-access'> {
    return new Secret('notion-user-access', value);
  }

  /** Write-through token minted by the GitHub callback; dies with that request. */
  static githubUserAccess(value: string): Secret<'github-user-access'> {
    return new Secret('github-user-access', value);
  }

  /** Token minted per provisioning message; discarded when the step returns. */
  static githubInstallation(value: string): Secret<'github-installation'> {
    return new Secret('github-installation', value);
  }

  /** Explicit unwrap. The only way the credential value leaves this object. */
  get raw(): string {
    return this.#value;
  }

  /** `Bearer ${raw}` for Authorization headers — the most common unwrap. */
  bearer(): string {
    return `Bearer ${this.#value}`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }
}
