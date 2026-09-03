package com.impact.parser.api;

import com.impact.parser.api.ParseExceptions.InternalFailureException;
import com.impact.parser.api.ParseExceptions.MalformedRequestException;
import com.impact.parser.api.ParseExceptions.WorkspaceNotFoundException;
import com.impact.parser.api.ParseExceptions.WorkspaceTooLargeException;
import com.impact.parser.workspace.SourceRootDiscovery.NoSourceRootsException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** {@code POST /v1/parse} (ARCHITECTURE.md §8). */
@RestController
public class ParseController {

    private final ParseService parseService;

    public ParseController(ParseService parseService) {
        this.parseService = parseService;
    }

    @PostMapping(path = "/v1/parse", produces = MediaType.APPLICATION_JSON_VALUE)
    public ParseResponse parse(@RequestBody ParseRequest request) {
        return parseService.parse(request);
    }

    // Deliberately explicit per-exception handlers rather than one catch-all:
    // the three request-level failures (400/404/422) each need a distinct
    // status and share the same small ErrorResponse body. The internal-failure
    // case is different again — its body is a full diagnostics-bearing
    // ParseResponse, not an ErrorResponse (§8: "500 ... body still carrying
    // diagnostics") — so it gets its own handler with its own body type. If
    // something escapes ParseService that isn't one of these four, Spring's
    // default 500 handling is the correct fallback, not a body this controller
    // fabricates.

    @ExceptionHandler(MalformedRequestException.class)
    public ResponseEntity<ErrorResponse> onMalformed(MalformedRequestException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(new ErrorResponse(e.getMessage()));
    }

    @ExceptionHandler(WorkspaceNotFoundException.class)
    public ResponseEntity<ErrorResponse> onWorkspaceNotFound(WorkspaceNotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ErrorResponse(e.getMessage()));
    }

    @ExceptionHandler(NoSourceRootsException.class)
    public ResponseEntity<ErrorResponse> onNoSourceRoots(NoSourceRootsException e) {
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(new ErrorResponse(e.getMessage()));
    }

    @ExceptionHandler(WorkspaceTooLargeException.class)
    public ResponseEntity<ErrorResponse> onWorkspaceTooLarge(WorkspaceTooLargeException e) {
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(new ErrorResponse(e.getMessage()));
    }

    @ExceptionHandler(InternalFailureException.class)
    public ResponseEntity<ParseResponse> onInternalFailure(InternalFailureException e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(e.response());
    }
}
