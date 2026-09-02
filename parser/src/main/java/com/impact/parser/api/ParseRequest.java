package com.impact.parser.api;

import java.util.List;

/**
 * The parse request of ARCHITECTURE.md §8.
 *
 * @param repoId opaque identifier, echoed back but not otherwise used — the
 *     parser is stateless and does not look repos up
 * @param sha recorded verbatim in the response; the parser does no git of its own
 * @param workspacePath absolute path to the worktree the Node worker prepared,
 *     already on the shared volume (D1)
 * @param mode {@code "full"} or {@code "subset"}
 * @param files workspace-relative paths to extract; required for
 *     {@code "subset"}, ignored for {@code "full"}
 * @param options request-level toggles; {@code null} is treated as defaults
 */
public record ParseRequest(
        String requestId,
        String repoId,
        String sha,
        String workspacePath,
        String mode,
        List<String> files,
        ParseOptions options) {

    /** @param includeTestSources also extract {@code src/test/java} (Q2 default: false) */
    public record ParseOptions(Boolean includeTestSources) {
        static final ParseOptions DEFAULTS = new ParseOptions(false);
    }

    public boolean includeTestSources() {
        return options != null && Boolean.TRUE.equals(options.includeTestSources());
    }

    public boolean isSubsetMode() {
        return "subset".equals(mode);
    }
}
