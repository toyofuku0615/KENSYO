export const CATEGORIES = [
  "現金・ギフト券",
  "Amazonギフト券",
  "家電・ガジェット",
  "旅行・宿泊",
  "食品・飲料",
  "日用品",
  "その他",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type RuleVerdict = "permitted" | "silent" | "prohibited" | "unknown";
export type ApplicationStatus =
  | "discovered"
  | "eligible"
  | "ready_to_submit"
  | "submitting"
  | "submitted"
  | "manual_required"
  | "blocked"
  | "failed"
  | "unknown_result"
  | "expired"
  | "won"
  | "lost";
export interface Profile {
  name: string;
  kana: string;
  postalCode: string;
  prefecture: string;
  address: string;
  phone: string;
  email: string;
  birthDate: string;
  gender?: string;
}
export interface Preferences {
  autoCollect: boolean;
  autoApply: boolean;
  emergencyStop: boolean;
  consentAt: string | null;
  approvedConsents: string[];
  maxApplications: number;
  categories: string[];
  excludedCategories: string[];
}
export interface Source {
  id: string;
  name: string;
  url: string;
  kind: "rss" | "html" | "fixture";
  enabled: boolean;
  termsAccepted: boolean;
  allowedHosts: string[];
}
export interface RuleEvidence {
  url: string;
  quote: string;
  fetchedAt: string;
  kind: "campaign" | "site" | "platform";
}
export interface CampaignRules {
  verdict: RuleVerdict;
  reason: string;
  evidence: RuleEvidence[];
  reviewedAllTerms: boolean;
  japanOnly: boolean;
  minAge: number | null;
  purchaseRequired: boolean;
  membershipRequired: boolean;
  snsRequired: boolean;
  captcha: boolean;
  maxEntries: number;
  requiredConsents: string[];
  requiredFields: string[];
  technicalAllowed: boolean;
}
export interface Campaign {
  id: string;
  title: string;
  organizer: string;
  officialUrl: string;
  entryUrl: string;
  imageUrl: string | null;
  prize: string;
  estimatedValue: number;
  winners: number;
  startsAt: string | null;
  deadline: string;
  category: string;
  conditions: string[];
  rules: CampaignRules;
  sourceId: string;
  discoveredAt: string;
  checkedAt: string;
  adapterId: string | null;
  isDemo: boolean;
}
export interface Application {
  id: string;
  campaignId: string;
  status: ApplicationStatus;
  receipt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  prizeValue: number | null;
}
export interface JobRun {
  id: string;
  kind: "collect" | "apply";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  errors: string[];
}
export interface AuditEntry {
  action: string;
  campaignId?: string;
  detail: string;
  createdAt: string;
}
export interface Store {
  getProfile(userId: string): Promise<Profile | null>;
  saveProfile(userId: string, profile: Profile): Promise<void>;
  getPreferences(userId: string): Promise<Preferences>;
  savePreferences(userId: string, preferences: Preferences): Promise<void>;
  listSources(userId: string): Promise<Source[]>;
  saveSource(userId: string, source: Source): Promise<void>;
  deleteSource(userId: string, id: string): Promise<void>;
  listCampaigns(userId: string): Promise<Campaign[]>;
  upsertCampaign(userId: string, campaign: Campaign): Promise<void>;
  listApplications(userId: string): Promise<Application[]>;
  claimApplication(
    userId: string,
    campaignId: string,
  ): Promise<Application | null>;
  updateApplication(
    userId: string,
    id: string,
    patch: Partial<
      Pick<Application, "status" | "receipt" | "error" | "prizeValue">
    >,
  ): Promise<void>;
  saveManualApplication(
    userId: string,
    campaignId: string,
    status: "submitted" | "won" | "lost",
    prizeValue?: number,
  ): Promise<void>;
  recordRun(userId: string, run: JobRun): Promise<void>;
  listRuns(userId: string): Promise<JobRun[]>;
  audit(userId: string, entry: AuditEntry): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  requestRun(userId: string, kind: "collect" | "apply"): Promise<void>;
  completeRunRequest(userId: string, kind: "collect" | "apply"): Promise<void>;
  takeRunRequests(userId: string): Promise<Array<"collect" | "apply">>;
  listUserIds(): Promise<string[]>;
}
export const DEFAULT_PREFERENCES: Preferences = {
  autoCollect: false,
  autoApply: false,
  emergencyStop: false,
  consentAt: null,
  approvedConsents: [],
  maxApplications: 10,
  categories: [...CATEGORIES],
  excludedCategories: [],
};
