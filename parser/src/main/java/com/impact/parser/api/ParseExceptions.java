package com.impact.parser.api;

/** The 400/404/500 error conditions of ARCHITECTURE.md §8. 422 is {@code NoSourceRootsException}. */
public final class ParseExceptions {

    private ParseExceptions() {}

    /** Malformed request: missing/blank fields, an unknown {@code mode}, subset mode with no files. */
    public static final class MalformedRequestException extends RuntimeException {
        public MalformedRequestException(String message) {
            super(message);
        }
    }

    /** {@code workspacePath} does not exist or is not a directory. */
    public static final class WorkspaceNotFoundException extends RuntimeException {
        public WorkspaceNotFoundException(String message) {
            super(message);
        }
    }

    /**
     * The file count to extract exceeds the provisional scale ceiling
     * (ARCHITECTURE §16.1 Q9, DECISIONS "Provisional scale ceiling"). Mapped to
     * {@code 413 Payload Too Large} — deliberately distinct from 422's "this
     * workspace has no Java source at all", since the client needs to tell "wrong
     * path" from "right path, too big for v1" apart.
     */
    public static final class WorkspaceTooLargeException extends RuntimeException {
        public WorkspaceTooLargeException(String message) {
            super(message);
        }
    }

    /**
     * Carries the diagnostics-bearing §8 500 body out of {@link ParseService}.
     *
     * <p>The body is a full {@link ParseResponse}, never a bespoke error object —
     * "500 internal failure, body still carrying {@code diagnostics}" (§8) — so
     * this is a transport for that response, not an alternative to it. A thrown
     * exception, rather than a returned value carrying a hidden failure flag, is
     * what lets {@link ParseController} set the status code the same way it
     * already does for 400/404/422, instead of every future change to
     * {@code parse()} having to remember to check a boolean.
     */
    public static final class InternalFailureException extends RuntimeException {
        private final transient ParseResponse response;

        public InternalFailureException(ParseResponse response, Throwable cause) {
            super(cause);
            this.response = response;
        }

        public ParseResponse response() {
            return response;
        }
    }
}
