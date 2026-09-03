/** Immutable import authorship/review history, and confirmed per-asset Git B.
 * Original signed wire anchors stay in snapshots; this baseline is actual G,
 * never a merged/resolved Memory document that Git has not received. */
const proposalRef=`FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE`
const member=(name:string)=>`${name}_membership_id UUID NOT NULL,${name}_membership_revision BIGINT NOT NULL CHECK(${name}_membership_revision>0),
  ${name}_authorization_epoch BIGINT NOT NULL CHECK(${name}_authorization_epoch>0),
  FOREIGN KEY(installation_id,${name}_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE`
const digest=(name:string)=>`${name} TEXT NOT NULL CHECK(${name} ~ '^[0-9a-f]{64}$')`
export const GIT_IMPORT_MIGRATION={version:43,statements:[
  `CREATE TABLE memory_git_resolution_authors(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),
    ${member('resolver')},${digest('document_hash')},created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,proposal_id,proposal_revision),${proposalRef})`,
  `CREATE TABLE memory_git_original_authors(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,run_id UUID NOT NULL,
    provider_actor_id TEXT NOT NULL CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256),${member('author')},
    head_commit TEXT NOT NULL CHECK(head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,proposal_id),${proposalRef},
    FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE)`,
  `ALTER TABLE memory_review_policy_sets ADD CONSTRAINT memory_git_policy_set_identity UNIQUE(installation_id,policy_id)`,
  `ALTER TABLE memory_review_policy_versions ADD CONSTRAINT memory_git_policy_version_identity UNIQUE(policy_id,policy_version_id)`,
  `ALTER TABLE knowledge_evidence ADD CONSTRAINT memory_git_evidence_version_identity UNIQUE(installation_id,evidence_id,version_id)`,
  `CREATE TABLE memory_git_governed_revisions(
    revision_id UUID PRIMARY KEY,installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,
    proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),base_revision BIGINT NOT NULL CHECK(base_revision>0),
    kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),claim_id UUID,wiki_id UUID,skill_id UUID,
    claim_version_id UUID,wiki_version_id UUID,skill_version_id UUID,
    CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),CHECK(num_nonnulls(claim_version_id,wiki_version_id,skill_version_id)=1),
    CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL AND claim_version_id IS NOT NULL) OR
      (kind='wiki' AND wiki_id IS NOT NULL AND wiki_version_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL AND skill_version_id IS NOT NULL)),
    ${digest('base_hash')},${digest('memory_hash')},${digest('git_hash')},${digest('proposed_hash')},${digest('policy_hash')},
    review_policy_id UUID NOT NULL,review_policy_version_id UUID NOT NULL,
    parent_installation_id UUID,parent_policy_id UUID,parent_policy_version_id UUID,
    CHECK(num_nonnulls(parent_installation_id,parent_policy_id,parent_policy_version_id) IN(0,3)),
    authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(installation_id,revision_id),UNIQUE(installation_id,proposal_id,proposal_revision),${proposalRef},
    FOREIGN KEY(installation_id,proposal_id) REFERENCES memory_git_original_authors(installation_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,claim_id,claim_version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,wiki_id,wiki_version_id) REFERENCES memory_wiki_versions(installation_id,wiki_id,wiki_version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,skill_id,skill_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,review_policy_id) REFERENCES memory_review_policy_sets(installation_id,policy_id),
    FOREIGN KEY(review_policy_id,review_policy_version_id) REFERENCES memory_review_policy_versions(policy_id,policy_version_id),
    FOREIGN KEY(parent_installation_id,parent_policy_id) REFERENCES memory_review_policy_sets(installation_id,policy_id),
    FOREIGN KEY(parent_policy_id,parent_policy_version_id) REFERENCES memory_review_policy_versions(policy_id,policy_version_id))`,
  `CREATE TABLE memory_git_revision_evidence(
    installation_id UUID NOT NULL,revision_id UUID NOT NULL,evidence_id UUID NOT NULL,version_id UUID NOT NULL,${digest('evidence_hash')},
    PRIMARY KEY(installation_id,revision_id,evidence_id),
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,evidence_id,version_id) REFERENCES knowledge_evidence(installation_id,evidence_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_revision_reviews(
    decision_id UUID PRIMARY KEY,installation_id UUID NOT NULL,revision_id UUID NOT NULL,${member('reviewer')},
    decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(installation_id,revision_id,reviewer_membership_id),UNIQUE(installation_id,decision_id),
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE)`,
  `ALTER TABLE memory_git_revision_links ADD CONSTRAINT memory_git_link_identity UNIQUE(installation_id,connection_id,link_id,binding_id)`,
  `CREATE TABLE memory_git_import_outcomes(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,proposal_revision BIGINT NOT NULL,
    revision_id UUID,link_id UUID NOT NULL,binding_id UUID NOT NULL,${member('publisher')},
    outcome TEXT NOT NULL CHECK(outcome IN('published','draft_appended','linked','revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,proposal_id),${proposalRef},
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,link_id,binding_id) REFERENCES memory_git_revision_links(installation_id,connection_id,link_id,binding_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_confirmed_bases(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,binding_id UUID NOT NULL,export_id UUID NOT NULL,link_id UUID NOT NULL,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,${digest('git_hash')},
    git_document JSONB NOT NULL CHECK(jsonb_typeof(git_document)='object' AND octet_length(git_document::text)<=2097152),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,connection_id,binding_id,link_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,link_id,binding_id) REFERENCES memory_git_revision_links(installation_id,connection_id,link_id,binding_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_claim_authority(
    installation_id UUID NOT NULL,claim_id UUID NOT NULL,version_id UUID NOT NULL,revision_id UUID NOT NULL,${member('publisher')},
    PRIMARY KEY(installation_id,version_id),
    FOREIGN KEY(installation_id,claim_id,version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_claim_authority_decisions(
    installation_id UUID NOT NULL,version_id UUID NOT NULL,decision_id UUID NOT NULL,
    PRIMARY KEY(installation_id,version_id,decision_id),
    FOREIGN KEY(installation_id,version_id) REFERENCES memory_git_claim_authority(installation_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,decision_id) REFERENCES memory_git_revision_reviews(installation_id,decision_id) ON DELETE CASCADE)`,
  ...['memory_git_resolution_authors','memory_git_original_authors','memory_git_governed_revisions','memory_git_revision_evidence','memory_git_revision_reviews',
    'memory_git_import_outcomes','memory_git_confirmed_bases','memory_git_claim_authority','memory_git_claim_authority_decisions'].map(table=>
    `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable()`),
] } as const
