export interface SettingsPolicy {
  defaultWorkflowPermissions?: 'read' | 'write';
  canApprovePullRequestReviews?: boolean;
  allowedActions?: 'all' | 'local_only' | 'selected';
  selectedActions?: {
    githubOwnedAllowed?: boolean;
    verifiedAllowed?: boolean;
    patternsAllowed?: string[];
  };
  requireRuleset?: { branch: string };
}

export interface SecretPolicy {
  name: string;
  scope: 'repo' | 'env';
  environment?: string;
  maxAgeDays: number;
  repos?: string[];
  group?: string;
}

export interface FleetConfig {
  repos: string[];
  groups?: Record<string, string[]>;
  settingsPolicy?: SettingsPolicy;
  secretPolicies?: SecretPolicy[];
}

export interface RepoRef {
  owner: string;
  repo: string;
  full: string;
}
