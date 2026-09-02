package com.impact.parser.graph;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Accumulates surfaces, collapsing repeats.
 *
 * <p>Two controller methods can legitimately map the same route (different HTTP
 * methods share a path), and several repositories can reference one entity — so a
 * surface key is emitted once and the edges carry the multiplicity, exactly as
 * {@link EdgeCollector} does for call sites.
 */
public final class SurfaceCollector {

    private final Map<String, Surface> surfaces = new LinkedHashMap<>();

    public void add(String key, SurfaceKind kind, Map<String, String> attrs) {
        surfaces.putIfAbsent(key, new Surface(key, kind, Map.copyOf(attrs)));
    }

    /** Every collected surface, sorted for determinism. */
    public List<Surface> toList() {
        return surfaces.values().stream()
                .sorted(Comparator.comparing(Surface::key))
                .toList();
    }
}
