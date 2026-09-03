package com.impact.parser.api;

import com.impact.parser.api.ParseExceptions.InternalFailureException;
import com.impact.parser.api.ParseExceptions.MalformedRequestException;
import com.impact.parser.api.ParseExceptions.WorkspaceNotFoundException;
import com.impact.parser.api.ParseExceptions.WorkspaceTooLargeException;
import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.extract.ParseError;
import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.graph.Surface;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Backs {@code POST /v1/parse} (ARCHITECTURE.md §8).
 *
 * <p><strong>Every field this class touches is either {@code final} or a
 * concurrent collection.</strong> That is not incidental — this service is
 * long-lived and handles overlapping requests for different repositories on
 * different threads, and the whole point of §8's purity guarantee collapses if
 * one request's extraction can observe another's state. Each call constructs its
 * own {@link WorkspaceLayout}, {@link com.github.javaparser.resolution.TypeSolver},
 * and {@link GraphExtractor} — nothing here is shared across requests except the
 * executor and the coalescing map below, and neither carries extraction state.
 * See {@code SameJvmDeterminismTest} and {@code ConcurrentRequestIsolationTest}.
 *
 * <p><strong>Concurrency, per §8:</strong> "CPU-bound; in-flight parses capped at
 * {@code cores - 1}, single-flight per {@code workspacePath}." Two mechanisms:
 *
 * <ul>
 *   <li>A fixed-size executor bounds how many extractions run <em>at once</em>
 *       to {@code cores - 1}, leaving a core for the web server and the JVM
 *       itself on a CPU-bound workload. Excess requests queue rather than being
 *       rejected — the client timeout (120s) is the backpressure signal, not an
 *       HTTP error.
 *   <li>A coalescing map deduplicates concurrent requests that would do
 *       <em>identical</em> work, so a redelivered webhook or an overlapping
 *       retry does not pay for the same parse twice.
 * </ul>
 *
 * <p><strong>The single-flight key is narrower than the spec's literal
 * wording.</strong> §8 says "per {@code workspacePath}", but coalescing on that
 * alone would be unsafe: a {@code full}-mode request and a {@code subset}-mode
 * request against the same workspace are not the same computation, and handing
 * the second one the first one's result would silently return the wrong graph.
 * In practice this collision cannot arise from the intended caller — the Node
 * worker holds a per-repo lock while a workspace is in use (ARCHITECTURE §9.2),
 * so two differently-shaped requests never race over one workspace — but this
 * service does not get to assume its caller's invariants. The key here is
 * {@code (workspacePath, mode, sorted files, includeTestSources)}: a strict
 * refinement that still coalesces the case the spec is guarding against
 * (repeated identical requests) while never coalescing two different questions.
 *
 * <p>Coalescing shares the underlying {@link ExtractionResult}, not the finished
 * {@link ParseResponse} envelope — each caller gets a response stamped with
 * <em>its own</em> {@code requestId}, even when the work behind it was shared.
 */
@Service
public final class ParseService {

    private static final Logger log = LoggerFactory.getLogger(ParseService.class);

    /** Matches the §8 contract text verbatim: the client-side timeout is 120s. */
    private static final long REQUEST_TIMEOUT_SECONDS = 120;

    /**
     * Provisional scale ceiling on the number of files one call will extract
     * (ARCHITECTURE §16.1 Q9; full basis in DECISIONS "Provisional scale
     * ceiling"). Deliberately gates on {@code files.size()} — the actual
     * extraction list — rather than total repo size, so a huge repo in
     * {@code subset} mode with only a handful of touched files is unaffected;
     * it is specifically {@code full}-mode indexing of a huge repo this exists
     * to catch, cheaply, before spending any CPU on it.
     *
     * <p><strong>How 500 was set.</strong> Three measured points, not two:
     * observability-final (71 files, ~1.1s) and spring-petclinic-rest (87
     * files, ~1.3s) cluster too closely to say anything about the curve's
     * <em>shape</em> — they pin the intercept, not the slope. The third point,
     * macrozheng/mall (519 files, 7 modules, 24.3s), is the one that matters
     * here: files grew ~6x over petclinic while wall-clock grew ~18x, a
     * superlinear relationship consistent with SymbolSolver's known behaviour
     * on cross-file reference resolution. With only one large-repo sample, an
     * extrapolated curve fit would be false confidence — so 500 is set{@code
     * at or below} the one point actually verified safe (519 files in 24.3s
     * against a ~30s parse-latency budget), not projected past it. The 30s
     * figure is a PR/push→ready latency budget, not GitHub's ~10s webhook ack
     * — that ack is already decoupled by BullMQ (C6), so it is irrelevant to
     * how long extraction itself may run.
     *
     * <p>Configurable rather than hardcoded, so raising it later — once §17's
     * classpath resolution or incremental indexing lands, or once more
     * large-repo data narrows the curve — is an operational change, not a
     * redeploy.
     */
    private final int maxFiles;

    private final ExecutorService executor;
    private final ConcurrentHashMap<String, CompletableFuture<Computed>> inFlight =
            new ConcurrentHashMap<>();
    private final AtomicInteger threadCounter = new AtomicInteger();

    public ParseService(@Value("${parser.scale.max-files:500}") int maxFiles) {
        this.maxFiles = maxFiles;
        int cores = Runtime.getRuntime().availableProcessors();
        int workers = Math.max(1, cores - 1);
        log.info(
                "parse executor: {} worker(s) ({} cores detected); scale ceiling {} files",
                workers,
                cores,
                maxFiles);
        this.executor =
                Executors.newFixedThreadPool(
                        workers,
                        runnable -> {
                            Thread thread = new Thread(runnable, "parser-worker-" + threadCounter.incrementAndGet());
                            // A stuck extraction must not stop the JVM from
                            // shutting down cleanly.
                            thread.setDaemon(true);
                            return thread;
                        });
    }

    @PreDestroy
    void shutdown() {
        executor.shutdown();
    }

    /** What coalesced callers share: the graph plus enough context to re-wrap it per caller. */
    private record Computed(WorkspaceLayout layout, ExtractionResult result, long durationMs) {}

    public ParseResponse parse(ParseRequest request) {
        validate(request);

        Path workspace = resolveWorkspace(request.workspacePath());
        boolean includeTests = request.includeTestSources();

        WorkspaceLayout probe;
        try {
            // Discovery is cheap relative to extraction and is what turns a bad
            // path into the 422 the caller can act on, so it runs outside the
            // coalescing map — every caller sees its own discovery failure rather
            // than borrowing someone else's.
            probe = SourceRootDiscovery.discover(workspace, includeTests);
        } catch (SourceRootDiscovery.NoSourceRootsException e) {
            throw e; // mapped to 422 by the controller
        }

        List<Path> files = resolveFiles(request, workspace, probe);
        if (files.size() > maxFiles) {
            // Fails before touching the coalescing map or the executor — the
            // whole point is to spend nothing on a request that is going to be
            // refused, not to queue it behind cores-1 other extractions first.
            throw new WorkspaceTooLargeException(
                    files.size()
                            + " files exceeds the provisional scale ceiling of "
                            + maxFiles
                            + " (ARCHITECTURE §16.1 Q9). This is a v1 limit from source+JDK"
                            + " resolution (D2), not a hard architectural one — see §17 for the"
                            + " classpath-resolution and incremental-indexing paths that raise it,"
                            + " or narrow the request to subset mode if only a few files changed.");
        }
        String key = coalescingKey(workspace, request.mode(), files, includeTests);

        long callerStart = System.currentTimeMillis();
        CompletableFuture<Computed> future =
                inFlight.computeIfAbsent(
                        key,
                        k -> {
                            CompletableFuture<Computed> submitted =
                                    CompletableFuture.supplyAsync(
                                            () -> compute(workspace, includeTests, files), executor);
                            // Coalescing is for callers that overlap in time; once
                            // the result exists, the next request should trigger a
                            // fresh parse rather than serve an arbitrarily stale one
                            // forever.
                            submitted.whenComplete((r, t) -> inFlight.remove(k, submitted));
                            return submitted;
                        });

        Computed computed;
        try {
            computed = future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            Throwable cause = unwrap(e);
            throw new InternalFailureException(failureResponse(request, callerStart, cause), cause);
        } catch (TimeoutException e) {
            RuntimeException timedOut =
                    new RuntimeException("parse exceeded " + REQUEST_TIMEOUT_SECONDS + "s", e);
            throw new InternalFailureException(failureResponse(request, callerStart, timedOut), timedOut);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new InternalFailureException(failureResponse(request, callerStart, e), e);
        }

        // Re-wrapped per caller: the coalesced work is shared, the envelope is not.
        // A caller whose request coalesced onto someone else's future still gets
        // its own requestId back, not the requestId of whoever triggered the parse.
        long callerDurationMs = System.currentTimeMillis() - callerStart;
        return ParseResponseMapper.toResponse(
                request.requestId(), request.sha(), request.mode(), computed.layout(), computed.result(), callerDurationMs);
    }

    private Computed compute(Path workspace, boolean includeTests, List<Path> files) {
        long start = System.currentTimeMillis();
        WorkspaceLayout layout = SourceRootDiscovery.discover(workspace, includeTests);
        ExtractionResult result =
                new GraphExtractor(new SourceAndJdkTypeSolverFactory().create(layout))
                        .extract(layout, files);
        return new Computed(layout, result, System.currentTimeMillis() - start);
    }

    // -----------------------------------------------------------------------
    // Validation and setup — outside the coalescing map, so every caller sees
    // its own error rather than one borrowed from a concurrent request.
    // -----------------------------------------------------------------------

    private static void validate(ParseRequest request) {
        if (request == null) {
            throw new MalformedRequestException("request body is required");
        }
        if (isBlank(request.workspacePath())) {
            throw new MalformedRequestException("workspacePath is required");
        }
        if (isBlank(request.mode())) {
            throw new MalformedRequestException("mode is required");
        }
        if (!request.mode().equals("full") && !request.mode().equals("subset")) {
            throw new MalformedRequestException("mode must be \"full\" or \"subset\", got: " + request.mode());
        }
        if (request.isSubsetMode() && (request.files() == null || request.files().isEmpty())) {
            throw new MalformedRequestException("files is required when mode is \"subset\"");
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static Path resolveWorkspace(String workspacePath) {
        Path path = Path.of(workspacePath).toAbsolutePath().normalize();
        if (!Files.isDirectory(path)) {
            throw new WorkspaceNotFoundException("workspacePath does not exist: " + path);
        }
        return path;
    }

    private static List<Path> resolveFiles(ParseRequest request, Path workspace, WorkspaceLayout layout) {
        if (!request.isSubsetMode()) {
            return SourceRootDiscovery.javaFiles(layout);
        }
        return request.files().stream()
                .map(relative -> workspace.resolve(relative).toAbsolutePath().normalize())
                .sorted()
                .toList();
    }

    private static String coalescingKey(Path workspace, String mode, List<Path> files, boolean includeTests) {
        // Files are already sorted by resolveFiles/SourceRootDiscovery, so the
        // joined form is stable regardless of request-body ordering.
        String filesDigest =
                files.stream().map(Path::toString).sorted(Comparator.naturalOrder())
                        .reduce("", (a, b) -> a + "|" + b);
        return String.join(
                " ",
                workspace.toString(),
                mode.toLowerCase(Locale.ROOT),
                filesDigest,
                Boolean.toString(includeTests));
    }

    private static Throwable unwrap(ExecutionException e) {
        Throwable cause = e.getCause();
        return cause != null ? cause : e;
    }

    /**
     * Builds the 500 body: an internal failure that escaped every layer of
     * resilience already built into extraction. The body still has
     * {@code ParseResponse} shape — never a bespoke error object — with the
     * failure recorded as a {@link ParseError} in diagnostics, so a caller
     * inspecting the response can tell what happened even though the run should
     * not be trusted (§8). Carried out of {@link #parse} inside an
     * {@link InternalFailureException} so {@link ParseController} can attach the
     * 500 status code — this method only builds the body, it does not decide the
     * transport.
     */
    private static ParseResponse failureResponse(ParseRequest request, long start, Throwable cause) {
        log.error("parse failed for workspacePath={}", request.workspacePath(), cause);
        long durationMs = System.currentTimeMillis() - start;
        List<ParseError> errors =
                List.of(new ParseError(request.workspacePath(), describeFailure(cause)));
        ParseDiagnostics diagnostics =
                new ParseDiagnostics(durationMs, 0, errors, 0, 0, 0.0, 0.0, 0, 0, List.of());
        return new ParseResponse(
                request.requestId(),
                request.sha(),
                Objects.requireNonNullElse(request.mode(), "full"),
                List.of(),
                List.<ParsedFunction>of(),
                List.<Surface>of(),
                List.<GraphEdge>of(),
                diagnostics);
    }

    private static String describeFailure(Throwable cause) {
        if (cause instanceof CompletionException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause.getClass().getSimpleName() + ": " + cause.getMessage();
    }
}
