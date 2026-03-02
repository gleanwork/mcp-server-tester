import React, { useState, useMemo } from 'react';
import {
  BarChart3,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  Folder,
} from 'lucide-react';
import type { EvalCaseResult } from '../../types';

interface ResultsTableProps {
  results: EvalCaseResult[];
  onSelectResult?: (result: EvalCaseResult) => void;
}

interface ResultGroup {
  name: string;
  results: EvalCaseResult[];
  passed: number;
  failed: number;
}

export function ResultsTable({ results, onSelectResult }: ResultsTableProps) {
  const [filter, setFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'eval' | 'test'>(
    'all'
  );
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  // Get unique projects from results
  const uniqueProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const r of results) {
      if (r.project) {
        projects.add(r.project);
      }
    }
    return Array.from(projects).sort();
  }, [results]);

  // Collect all unique tags across results
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const r of results) {
      for (const tag of r.tags ?? []) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }, [results]);

  const filteredResults = useMemo(() => {
    let filtered = [...results];

    if (filter === 'pass') {
      filtered = filtered.filter((r) => r.pass);
    } else if (filter === 'fail') {
      filtered = filtered.filter((r) => !r.pass);
    }

    if (sourceFilter !== 'all') {
      filtered = filtered.filter((r) => r.source === sourceFilter);
    }

    if (projectFilter !== 'all') {
      filtered = filtered.filter((r) => r.project === projectFilter);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((r) => {
        return (
          r.id.toLowerCase().includes(query) ||
          r.datasetName.toLowerCase().includes(query) ||
          JSON.stringify(r.response).toLowerCase().includes(query)
        );
      });
    }

    if (selectedTags.size > 0) {
      filtered = filtered.filter((r) => {
        const resultTags = r.tags ?? [];
        for (const tag of selectedTags) {
          if (!resultTags.includes(tag)) {
            return false;
          }
        }
        return true;
      });
    }

    return filtered;
  }, [results, filter, sourceFilter, projectFilter, searchQuery, selectedTags]);

  const groupedResults = useMemo(() => {
    const groups = new Map<string, EvalCaseResult[]>();

    for (const result of filteredResults) {
      const key = result.datasetName || 'Uncategorized';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(result);
    }

    const resultGroups: ResultGroup[] = [];
    for (const [name, groupResults] of groups) {
      resultGroups.push({
        name,
        results: groupResults,
        passed: groupResults.filter((r) => r.pass).length,
        failed: groupResults.filter((r) => !r.pass).length,
      });
    }

    return resultGroups;
  }, [filteredResults]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  };

  const evalCount = results.filter((r) => r.source === 'eval').length;
  const testCount = results.filter((r) => r.source === 'test').length;

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b bg-card">
        <button
          onClick={() => setSourceFilter('all')}
          className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
            sourceFilter === 'all'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
          }`}
        >
          All Results
          <span className="text-xs bg-muted px-2 py-0.5 rounded-full">
            {results.length}
          </span>
        </button>
        <button
          onClick={() => setSourceFilter('eval')}
          className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
            sourceFilter === 'eval'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
          }`}
        >
          <BarChart3 size={16} />
          Eval Datasets
          <span className="text-xs bg-muted px-2 py-0.5 rounded-full">
            {evalCount}
          </span>
        </button>
        <button
          onClick={() => setSourceFilter('test')}
          className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
            sourceFilter === 'test'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
          }`}
        >
          <FlaskConical size={16} />
          Test Suites
          <span className="text-xs bg-muted px-2 py-0.5 rounded-full">
            {testCount}
          </span>
        </button>
      </div>

      {/* Tag filter — only shown when any result has tags */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center px-4 py-2 bg-card border-b">
          <span className="text-xs text-muted-foreground shrink-0">Tags:</span>
          {allTags.map((tag) => {
            const isSelected = selectedTags.has(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-muted-foreground/40 hover:border-primary hover:text-foreground'
                }`}
              >
                {tag}
              </button>
            );
          })}
          {selectedTags.size > 0 && (
            <button
              onClick={() => setSelectedTags(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline ml-1"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-center p-4 bg-card border-b">
        <input
          type="text"
          placeholder="Search by case ID or response content..."
          className="flex-1 min-w-[250px] px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {/* Project Filter - only show if multiple projects */}
        {uniqueProjects.length > 1 && (
          <div className="flex items-center gap-2">
            <Folder size={16} className="text-muted-foreground" />
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Projects</option>
              {uniqueProjects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilter('pass')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              filter === 'pass'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            }`}
          >
            Passed
          </button>
          <button
            onClick={() => setFilter('fail')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              filter === 'fail'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            }`}
          >
            Failed
          </button>
        </div>
      </div>

      {/* Grouped Results */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {groupedResults.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            No results found
          </div>
        ) : (
          <div className="divide-y">
            {groupedResults.map((group) => {
              const isCollapsed = collapsedGroups.has(group.name);
              const allPassed = group.failed === 0;

              return (
                <div key={group.name}>
                  {/* Group Header */}
                  <button
                    onClick={() => toggleGroup(group.name)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isCollapsed ? (
                        <ChevronRight
                          size={18}
                          className="text-muted-foreground"
                        />
                      ) : (
                        <ChevronDown
                          size={18}
                          className="text-muted-foreground"
                        />
                      )}
                      <span className="font-medium">{group.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({group.results.length}{' '}
                        {group.results.length === 1 ? 'test' : 'tests'})
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-sm font-medium ${
                          allPassed
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {group.passed}/{group.results.length} passed
                      </span>
                      {group.failed > 0 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-700 dark:text-red-400">
                          {group.failed} failed
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Group Results */}
                  {!isCollapsed && (
                    <div>
                      {group.results.map((result) => {
                        const source = result.source || 'eval';
                        const isEval = source === 'eval';

                        // Regression delta badge logic
                        const showRegressed =
                          result.baselinePass === true &&
                          result.pass === false;
                        const showFixed =
                          result.baselinePass === false &&
                          result.pass === true;

                        // Sparkline: cap at 10 dots
                        const iterDots = result.iterationResults ?? [];
                        const cappedDots = iterDots.slice(0, 10);
                        const hasMore = iterDots.length > 10;

                        return (
                          <div
                            key={result.id}
                            onClick={() => onSelectResult?.(result)}
                            className={`flex items-center gap-4 px-4 py-3 border-b cursor-pointer hover:bg-accent/50 transition-colors ${
                              isEval
                                ? 'border-l-4 border-l-blue-500/30 bg-blue-500/5'
                                : 'border-l-4 border-l-purple-500/30 bg-purple-500/5'
                            }`}
                          >
                            {/* Status */}
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                                result.pass
                                  ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                                  : 'bg-red-500/20 text-red-700 dark:text-red-400'
                              }`}
                            >
                              {result.pass ? '✓ Pass' : '✗ Fail'}
                            </span>

                            {/* Regression delta badge */}
                            {showRegressed && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold shrink-0 bg-red-500/15 text-red-700 dark:text-red-400">
                                ▼ regressed
                              </span>
                            )}
                            {showFixed && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold shrink-0 bg-green-500/15 text-green-700 dark:text-green-400">
                                ▲ fixed
                              </span>
                            )}

                            {/* Accuracy badge — only for multi-iteration cases */}
                            {result.assertionPassRate !== undefined && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold shrink-0 ${
                                  result.assertionPassRate >= 0.8
                                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                    : result.assertionPassRate >= 0.5
                                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                                      : 'bg-red-500/15 text-red-700 dark:text-red-400'
                                }`}
                                title={`${result.iterationResults?.filter((r) => r.pass).length ?? '?'}/${result.iterationResults?.length ?? '?'} iterations passed`}
                              >
                                {(result.assertionPassRate * 100).toFixed(0)}%
                                <span className="opacity-60 font-normal">
                                  {result.iterationResults
                                    ? ` ${result.iterationResults.filter((r) => r.pass).length}/${result.iterationResults.length}`
                                    : ''}
                                </span>
                              </span>
                            )}

                            {/* Iteration sparkline — only for multi-iteration cases */}
                            {iterDots.length > 0 && (
                              <span
                                className="inline-flex items-center gap-0.5 shrink-0 font-mono text-sm"
                                title={`${iterDots.length} iterations`}
                              >
                                {cappedDots.map((iter, i) => (
                                  <span
                                    key={i}
                                    className={
                                      iter.isInfrastructureError
                                        ? 'text-gray-400'
                                        : iter.pass
                                          ? 'text-green-500'
                                          : 'text-red-500'
                                    }
                                  >
                                    {iter.isInfrastructureError ? '○' : '●'}
                                  </span>
                                ))}
                                {hasMore && (
                                  <span className="text-muted-foreground text-xs">
                                    +
                                  </span>
                                )}
                              </span>
                            )}

                            {/* Tool precision / recall badges */}
                            {result.toolPrecision !== undefined && (
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs shrink-0 bg-muted text-muted-foreground"
                                title="Tool precision: fraction of tool calls that were expected"
                              >
                                P: {(result.toolPrecision * 100).toFixed(0)}%
                              </span>
                            )}
                            {result.toolRecall !== undefined && (
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs shrink-0 bg-muted text-muted-foreground"
                                title="Tool recall: fraction of required tools that were called"
                              >
                                R: {(result.toolRecall * 100).toFixed(0)}%
                              </span>
                            )}

                            {/* Type Icon */}
                            <span className="shrink-0">
                              {isEval ? (
                                <BarChart3
                                  size={16}
                                  className="text-blue-600 dark:text-blue-400"
                                  title="Eval Dataset"
                                />
                              ) : (
                                <FlaskConical
                                  size={16}
                                  className="text-purple-600 dark:text-purple-400"
                                  title="Test Suite"
                                />
                              )}
                            </span>

                            {/* Case ID */}
                            <span className="flex-1 text-sm font-medium truncate">
                              {result.id}
                            </span>

                            {/* Tool Name */}
                            <code className="text-xs bg-muted px-2 py-1 rounded shrink-0">
                              {result.toolName}
                            </code>

                            {/* Project Badge - only show if multiple projects */}
                            {uniqueProjects.length > 1 && result.project && (
                              <span className="px-2 py-0.5 text-xs rounded shrink-0 bg-slate-500/20 text-slate-700 dark:text-slate-400">
                                {result.project}
                              </span>
                            )}

                            {/* Duration */}
                            <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
                              {result.durationMs.toFixed(0)}ms
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
