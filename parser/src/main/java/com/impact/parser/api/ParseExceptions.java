package com.impact.parser.api;

/** The 400/404 error conditions of ARCHITECTURE.md §8. 422 is {@code NoSourceRootsException}. */
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
}
