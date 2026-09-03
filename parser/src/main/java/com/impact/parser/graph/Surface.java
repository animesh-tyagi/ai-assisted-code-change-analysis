package com.impact.parser.graph;

import java.util.Map;

/**
 * A non-method node (ARCHITECTURE.md §6.2, §8 {@code surfaces[]}).
 *
 * <p>Surfaces are the terminals the traversal collapses to: an HTTP route, a
 * scheduled job, a listener, an entity, a table. Collapsing to them is what keeps
 * a change to a util method from fanning out to hundreds of intermediate nodes
 * (§10, Zone 2).
 *
 * @param attrs kind-specific detail, sorted so output bytes stay stable
 */
public record Surface(String key, SurfaceKind kind, Map<String, String> attrs) {}
