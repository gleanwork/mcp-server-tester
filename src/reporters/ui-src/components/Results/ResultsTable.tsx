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
  /** Pre-select source filter tab when embedded in a parent tab */
  defaultSource?: 'eval' | 'test';
}

interface ResultGroup {
  name: string;
  results: EvalCaseResult[];
  passed: number;
  failed: number;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

interface ResultRowProps {
  result: EvalCaseResult;
  onSelectResult?: (result: EvalCaseResult) => void;
  showProjectBadge: boolean;
}

function ResultRow({
  result,
  onSelectResult,
  showProjectBadge,
}: ResultRowProps) {
  const source = result.source || 'eval';
  const isEval = source === 'eval';

  const showRegressed = result.baselinePass === true && result.pass === false;
  const showFixed = result.baselinePass === false && result.pass === true;

  const iterDots = result.iterationResults ?? [];
  const cappedDots = iterDots.slice(0, 10);
  const hasMore = iterDots.length > 10;

  const ariaLabel = `${result.toolName ? result.toolName + ': ' : ''}${result.id}, ${result.pass ? 'passed' : 'failed'}`;

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      onSelectResult?.(result);
    } else if (event.key === ' ') {
      event.preventDefault();
      onSelectResult?.(result);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={() => onSelectResult?.(result)}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-4 px-4 py-3 border-b cursor-pointer hover:bg-accent/50 transition-colors ${
        isEval
          ? 'border-l-4 border-l-blue-500/30 bg-blue-500/5'
          : 'border-l-4 border-l-purple-500/30 bg-purple-500/5'
      }`}
    >
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
          result.pass
            ? 'bg-green-500/20 text-green-700 dark:text-green-400'
            : 'bg-red-500/20 text-red-700 dark:text-red-400'
        }`}
      >
        {result.pass ? '✓ Pass' : '✗ Fail'}
      </span>

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
          {hasMore && <span className="text-muted-foreground text-xs">+</span>}
        </span>
      )}

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

      <span className="flex-1 text-sm font-medium truncate">{result.id}</span>

      <code className="text-xs bg-muted px-2 py-1 rounded shrink-0">
        {result.toolName}
      </code>

      {showProjectBadge && result.project && (
        <span className="px-2 py-0.5 text-xs rounded shrink-0 bg-slate-500/20 text-slate-700 dark:text-slate-400">
          {result.project}
        </span>
      )}

      <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
        {formatMs(result.durationMs)}
      </span>
    </div>
  );
}

export function ResultsTable({
  results,
  onSelectResult,
  defaultSource,
}: ResultsTableProps) {
  const [filter, setFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'eval' | 'test'>(
    defaultSource ?? 'all'
  );
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  const uniqueProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const r of results) {
      if (r.project) {
        projects.add(r.project);
      }
    }
    return Array.from(projects).sort();
  }, [results]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const r of results) {
      for (const tag of r.tags ?? []) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }, [results]);

  const evalCount = useMemo(
    () => results.filter((r) => r.source === 'eval').length,
    [results]
  );

  const testCount = useMemo(
    () => results.filter((r) => r.source === 'test').length,
    [results]
  );

  const searchIndex = useMemo(
    () =>
      results.map((r) =>
        (r.response != null ? JSON.stringify(r.response) : '').toLowerCase()
      ),
    [results]
  );

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
      const lowerQuery = searchQuery.toLowerCase();
      filtered = filtered.filter((r) => {
        const index = results.indexOf(r);
        return (
          r.id.toLowerCase().includes(lowerQuery) ||
          r.datasetName.toLowerCase().includes(lowerQuery) ||
          searchIndex[index].includes(lowerQuery)
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
  }, [
    results,
    filter,
    sourceFilter,
    projectFilter,
    searchQuery,
    selectedTags,
    searchIndex,
  ]);

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

  return (
    <div className="flex flex-col h-full">
      {!defaultSource && (
        <div role="tablist" className="flex border-b bg-card">
          <button
            role="tab"
            aria-selected={sourceFilter === 'all'}
            aria-controls="results-list"
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
            role="tab"
            aria-selected={sourceFilter === 'eval'}
            aria-controls="results-list"
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
            role="tab"
            aria-selected={sourceFilter === 'test'}
            aria-controls="results-list"
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
      )}

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center px-4 py-2 bg-card border-b">
          <span className="text-xs text-muted-foreground shrink-0">Tags:</span>
          {allTags.map((tag) => {
            const isSelected = selectedTags.has(tag);
            return (
              <button
                key={tag}
                aria-pressed={isSelected}
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

      <div className="flex flex-wrap gap-4 items-center p-4 bg-card border-b">
        <input
          type="text"
          aria-label="Search results"
          placeholder="Search by case ID or response content..."
          className="flex-1 min-w-[250px] px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {uniqueProjects.length > 1 && (
          <div className="flex items-center gap-2">
            <Folder size={16} className="text-muted-foreground" />
            <select
              aria-label="Filter by project"
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
            aria-pressed={filter === 'all'}
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
            aria-pressed={filter === 'pass'}
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
            aria-pressed={filter === 'fail'}
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

      <div id="results-list" className="flex-1 overflow-y-auto scrollbar-thin">
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

                  {!isCollapsed && (
                    <div>
                      {group.results.map((result) => (
                        <ResultRow
                          key={result.id}
                          result={result}
                          onSelectResult={onSelectResult}
                          showProjectBadge={uniqueProjects.length > 1}
                        />
                      ))}
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
