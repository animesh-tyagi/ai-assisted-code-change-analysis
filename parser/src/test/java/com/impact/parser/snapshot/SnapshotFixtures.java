package com.impact.parser.snapshot;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Two small, hand-written fixture repositories used only for golden-master
 * comparison (BUILD_PLAN Step 2 phase 8, "snapshot-test the parser output on a
 * fixture repo").
 *
 * <p>These are fixtures, not validation. DECISIONS' "no toy examples" rule
 * governs whether a <em>rule</em> is proven correct — that evidence comes from
 * {@code RealRepoExtractionTest} against observability-final and
 * spring-petclinic-rest. A snapshot's job is different: pin the exact bytes a
 * known input produces, so a future change that alters output — deliberately or
 * not — shows up as a reviewable diff on a checked-in file. Fixtures are the
 * right tool for that, because they hold still; a real repo's output would drift
 * every time its own upstream changed, for reasons that have nothing to do with
 * this parser.
 *
 * <p>No absolute path appears anywhere in the response — every {@code filePath}
 * is workspace-relative (§8) — so these fixtures are stable regardless of which
 * machine or {@code @TempDir} they run from.
 */
final class SnapshotFixtures {

    private SnapshotFixtures() {}

    private static void write(Path root, String relative, String source) throws IOException {
        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    /**
     * Covers {@code calls}, {@code implements}, interface dispatch (both the
     * single-selector and the ambiguous path), inherited route mappings, and
     * {@code triggers}/{@code scheduled_job}. Deliberately quiet on diagnostics —
     * everything here resolves — so {@code springData()} is what pins non-zero
     * unresolved/external numbers.
     */
    static void core(Path root) throws IOException {
        write(
                root,
                "src/main/java/com/acme/Strategy.java",
                """
                package com.acme;
                public interface Strategy {
                    void execute(String input);
                }
                """);
        write(
                root,
                "src/main/java/com/acme/PrimaryStrategy.java",
                """
                package com.acme;
                @Primary
                public class PrimaryStrategy implements Strategy {
                    public void execute(String input) {}
                }
                """);
        write(
                root,
                "src/main/java/com/acme/SecondaryStrategy.java",
                """
                package com.acme;
                public class SecondaryStrategy implements Strategy {
                    public void execute(String input) {}
                }
                """);
        write(
                root,
                "src/main/java/com/acme/Dispatcher.java",
                """
                package com.acme;
                public class Dispatcher {
                    void run(Strategy strategy) { strategy.execute("x"); }
                }
                """);
        // A second interface, deliberately with NEITHER implementation annotated,
        // so select() has nothing to choose between them and both get edges at
        // confidence: ambiguous. Strategy above resolves through @Primary instead
        // (single_impl) — without this second pair the ambiguous branch of
        // InterfaceDispatchRules.select() would never fire in this snapshot at
        // all, silently leaving it unpinned. Mirrors observability-final's real
        // FailureStrategy, which has four impls and no annotations anywhere.
        write(
                root,
                "src/main/java/com/acme/Handler.java",
                """
                package com.acme;
                public interface Handler {
                    void handle(String event);
                }
                """);
        write(
                root,
                "src/main/java/com/acme/LeftHandler.java",
                """
                package com.acme;
                public class LeftHandler implements Handler {
                    public void handle(String event) {}
                }
                """);
        write(
                root,
                "src/main/java/com/acme/RightHandler.java",
                """
                package com.acme;
                public class RightHandler implements Handler {
                    public void handle(String event) {}
                }
                """);
        write(
                root,
                "src/main/java/com/acme/HandlerDispatcher.java",
                """
                package com.acme;
                public class HandlerDispatcher {
                    void run(Handler handler) { handler.handle("x"); }
                }
                """);
        // No mapping of its own — inherits from ThingsApi, exercising the route
        // inheritance rule alongside the class-level prefix.
        write(
                root,
                "src/main/java/com/acme/api/ThingsApi.java",
                """
                package com.acme.api;
                public interface ThingsApi {
                    @org.springframework.web.bind.annotation.GetMapping("/things/{id}")
                    String getThing(int id);
                }
                """);
        write(
                root,
                "src/main/java/com/acme/ThingController.java",
                """
                package com.acme;
                import com.acme.api.ThingsApi;
                @RestController
                @RequestMapping("/api")
                public class ThingController implements ThingsApi {
                    public String getThing(int id) { return "x"; }
                }
                """);
        write(
                root,
                "src/main/java/com/acme/Job.java",
                """
                package com.acme;
                public class Job {
                    @Scheduled(fixedRate = 5000, initialDelay = 10)
                    void tick() {}
                }
                """);
    }

    /**
     * Covers Spring Data {@code queries}/{@code maps_to} and entity/table
     * surfaces via the split-interface shape (the marker declares nothing;
     * callers hold the domain interface — see {@code SpringDataCompositionTest}),
     * plus two diagnostics-bearing cases the {@code core} fixture leaves at
     * zero: an unresolvable third-party parameter type
     * ({@code unresolvedParamTypes}, {@code unresolvedRate}) and a call that
     * resolves to the JDK ({@code externalCalls}).
     */
    static void springData(Path root) throws IOException {
        write(
                root,
                "src/main/java/com/acme/model/Widget.java",
                """
                package com.acme.model;
                @Entity
                @Table(name = "widgets")
                public class Widget {
                    private String name;
                    public String getName() { return name; }
                }
                """);
        write(
                root,
                "src/main/java/com/acme/repository/WidgetRepository.java",
                """
                package com.acme.repository;
                import com.acme.model.Widget;
                import java.util.Collection;
                public interface WidgetRepository {
                    Collection<Widget> findByName(String name);
                }
                """);
        write(
                root,
                "src/main/java/com/acme/repository/springdatajpa/SpringDataWidgetRepository.java",
                """
                package com.acme.repository.springdatajpa;
                import com.acme.model.Widget;
                import com.acme.repository.WidgetRepository;
                import org.springframework.data.repository.Repository;
                public interface SpringDataWidgetRepository
                        extends WidgetRepository, Repository<Widget, Integer> {
                }
                """);
        write(
                root,
                "src/main/java/com/acme/service/WidgetService.java",
                """
                package com.acme.service;
                import com.acme.model.Widget;
                import com.acme.repository.WidgetRepository;
                import java.util.Collection;
                import java.util.ArrayList;
                public class WidgetService {
                    private final WidgetRepository widgetRepository;
                    public WidgetService(WidgetRepository widgetRepository) {
                        this.widgetRepository = widgetRepository;
                    }
                    public Collection<Widget> find(String name) {
                        // A JDK call — resolves, but outside the extraction set:
                        // externalCalls, not an edge (section 6.5 bucket 2).
                        Collection<Widget> extra = new ArrayList<>();
                        return widgetRepository.findByName(name);
                    }
                    // An unresolvable third-party parameter type: falls back to
                    // import-based naming and counts toward unresolvedParamTypes.
                    public void handle(com.thirdparty.Widget external) {}
                }
                """);
    }
}
