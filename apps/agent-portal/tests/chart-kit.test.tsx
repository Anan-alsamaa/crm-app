import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { HBarChart, SplitBar, TrendChart, type ChartSeries } from '@yiji/ui';

/**
 * The chart kit is hand-drawn, so the things a charting library would get right
 * for free are exactly the things worth pinning: a null is a gap and never a
 * zero, an all-zero dataset does not divide by zero, and every value is
 * readable without hovering.
 */
const series: ChartSeries[] = [
  { key: 'first', label: 'First response', tone: 'primary' },
  { key: 'solve', label: 'Time to solve', tone: 'violet' },
];
const secs = (v: number) => `${v}s`;

describe('HBarChart', () => {
  it('labels every value on the chart rather than behind a hover', () => {
    // A bar you have to hover to read cannot be compared with the one below it,
    // and comparison is the entire job.
    render(
      <HBarChart
        rows={[{ label: 'Sara', values: { first: 60, solve: 600 } }]}
        series={series}
        format={secs}
      />,
    );
    expect(screen.getByText('60s')).toBeInTheDocument();
    expect(screen.getByText('600s')).toBeInTheDocument();
  });

  it('draws a null as an em dash, never as a zero-length bar', () => {
    // A zero-width bar reads as "instant", which is the opposite of "unknown".
    render(
      <HBarChart
        rows={[{ label: 'Sara', values: { first: 60, solve: null } }]}
        series={series}
        format={secs}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('says so rather than drawing an all-zero dataset', () => {
    // The naive scale divides by the max and paints every bar full width.
    // Guarding that leaves a column of empty tracks each labelled 0, which is
    // the shape of a chart with no information in it — a reader takes that for
    // broken rendering, not for "none of this happened".
    render(
      <HBarChart
        rows={[{ label: 'Sara', values: { first: 0, solve: 0 } }]}
        series={series}
        format={secs}
        emptyLabel="Nothing measured"
      />,
    );
    expect(screen.getByText('Nothing measured')).toBeInTheDocument();
    expect(screen.queryByText('Sara')).not.toBeInTheDocument();
  });

  it('says so when there is nothing to chart', () => {
    render(<HBarChart rows={[]} series={series} format={secs} emptyLabel="No chats" />);
    expect(screen.getByText('No chats')).toBeInTheDocument();
  });

  it('says so when there are rows but nothing in them was ever measured', () => {
    // A column of empty tracks and em dashes has the SHAPE of a chart and none
    // of the information, so it reads as broken rather than as "not measured".
    render(
      <HBarChart
        rows={[{ label: 'Sara', values: { first: null, solve: null } }]}
        series={series}
        format={secs}
        emptyLabel="Nothing answered yet"
      />,
    );
    expect(screen.getByText('Nothing answered yet')).toBeInTheDocument();
    expect(screen.queryByText('Sara')).not.toBeInTheDocument();
  });

  it('carries the per-row note, so an average is never read without its count', () => {
    render(
      <HBarChart
        rows={[{ label: 'Sara', values: { first: 60 }, note: '3 chats' }]}
        series={[series[0]!]}
        format={secs}
      />,
    );
    expect(screen.getByText('3 chats')).toBeInTheDocument();
  });
});

describe('TrendChart', () => {
  it('breaks the line rather than drawing a gap as zero', () => {
    const { container } = render(
      <TrendChart
        points={[
          { label: '08-01', values: { first: 60 } },
          { label: '08-02', values: { first: null } },
          { label: '08-03', values: { first: 90 } },
        ]}
        series={[series[0]!]}
        format={secs}
      />,
    );
    // Two runs => two stroked paths (the area fills only draw on multi-point
    // runs). One would mean the gap was bridged, which would read as
    // "answered instantly" on a day nobody worked.
    expect(container.querySelectorAll('path[fill="none"]')).toHaveLength(2);
  });

  it('shows the scale so the shape can be read as a size', () => {
    render(
      <TrendChart
        points={[
          { label: '08-01', values: { first: 60 } },
          { label: '08-02', values: { first: 120 } },
        ]}
        series={[series[0]!]}
        format={secs}
      />,
    );
    expect(screen.getByText('120s')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('says so when every point is unmeasurable', () => {
    render(
      <TrendChart
        points={[{ label: '08-01', values: { first: null } }]}
        series={[series[0]!]}
        format={secs}
        emptyLabel="Nothing yet"
      />,
    );
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });
});

describe('SplitBar', () => {
  it('shows counts alongside the percentages', () => {
    // A percentage alone hides whether it came from four chats or four hundred.
    const { container } = render(
      <SplitBar
        parts={[
          { label: 'Met', value: 3, tone: 'success' },
          { label: 'Missed', value: 1, tone: 'destructive' },
        ]}
      />,
    );
    expect(within(container).getByText('3')).toBeInTheDocument();
    expect(within(container).getByText('(75%)')).toBeInTheDocument();
    expect(within(container).getByText('(25%)')).toBeInTheDocument();
  });

  it('renders nothing at all rather than an empty bar', () => {
    const { container } = render(
      <SplitBar parts={[{ label: 'Met', value: 0, tone: 'success' }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
