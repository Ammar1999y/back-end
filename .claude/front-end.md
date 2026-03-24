## Core Architecture Principles

### Single Responsibility Principle (SRP)

Every component/function should have ONE clear purpose:

- **UI components**: Presentation only
- **Container components**: Logic and data fetching
- **Custom hooks**: Reusable logic
- **Utility functions**: Pure computations

### Container/Presentational Pattern

Separate business logic from UI:

```typescript
// Container (logic)
function UserListContainer() {
  const { data, isLoading } = useQuery({...});
  return <UserListView data={data} isLoading={isLoading} />;
}

// Presentation (UI only)
function UserListView({ data, isLoading }) {
  if (isLoading) return <Skeleton />;
  return <ul>{data.map(...)}</ul>;
}
```

### Component Size Guidelines

- **< 200 lines**: Ideal component size
- **> 200 lines**: Break down into:
  - Sub-components for UI sections
  - Custom hooks for logic
  - Utility files for helpers
  - Separate concerns (data, state, rendering)

```typescript
// Before: Large component with inline tooltip
function LargeComponent() {
  return (
    <div>
      {/* 100 lines of code */}
      <Tooltip>
        <TooltipTrigger>
          <Label />
        </TooltipTrigger>
        <TooltipContent>Info</TooltipContent>
      </Tooltip>
      {/* More code */}
    </div>
  );
}

// After: Extracted small widget
const InfoTooltip = memo(({ label, info }: Props) => (
  <Tooltip>
    <TooltipTrigger>
      <Label>{label}</Label>
    </TooltipTrigger>
    <TooltipContent>{info}</TooltipContent>
  </Tooltip>
));
InfoTooltip.displayName = 'InfoTooltip';

function LargeComponent() {
  return (
    <div>
      {/* 100 lines of code */}
      <InfoTooltip label='Info' info='Details here' />
      {/* More code */}
    </div>
  );
}
```

### File Organization

```
components/
├── ui/                           # shadcn/ui components
├── shared/                       # Reusable components
└── [feature-name]/              # Complex features
    ├── [feature-name].tsx       # Main container
    ├── [feature-name]-view.tsx  # Presentation
    ├── use-[feature-name].ts    # Custom hook
    ├── store.ts                 # Zustand store
    ├── types.ts                 # TypeScript types
    ├── utils.ts                 # Helper functions
    └── [feature-name]/          # Sub-components (for large features)
        ├── index.tsx            # Main composition component
        ├── component-a.tsx      # Sub-component A
        ├── component-b.tsx      # Sub-component B
        └── small-widget.tsx     # Small reusable widget
```

**When to create sub-component folders:**

- Feature has > 200 lines and can be split into logical sections
- Multiple related components that are only used within this feature
- Better organization and maintainability

---

## State Management (Zustand)

### Core Patterns

1. **Use atomic selectors** - Prevent unnecessary re-renders

```typescript
// ✅ GOOD - Only re-renders when specific value changes
import { useShallow } from 'zustand/shallow';

const count = useStore(useShallow((s) => s.count));

// ❌ BAD - Re-renders on any state change
const { count } = useStore();
```

2. **Use getState() in callbacks** - Avoid subscriptions and dependencies when
   state is only needed for updates

```typescript
// ✅ GOOD - No dependencies, no re-renders
const handleClick = useCallback(() => {
  const { count, setCount } = useStore.getState();
  setCount(count + 1);
}, []); // Empty dependencies array

// ✅ GOOD - Multiple store access in one callback
const handleUpdate = useCallback((layout: string) => {
  const settings = useSettingStore.getState().settings;
  const setSettings = useSettingStore.getState().actions.setSettings;
  setSettings({ ...settings, layout });
}, []); // No dependencies needed!

// ❌ BAD - Unnecessary subscription and dependencies
const handleClick = useCallback(() => {
  setCount(count + 1);
}, [count, setCount]); // Component re-renders when count changes
```

**When to use `getState()`:**

- Inside event handlers that only update state
- When you don't need the value for rendering
- To keep dependency arrays empty and prevent re-renders

3. **Isolate frequently updating state** - Use dedicated components for side
   effects

```typescript
// Side effect handler (returns null, no UI cost)
const ChangeHandler = memo(({ onDataChange }) => {
  const state = useStore(s => s.state);
  useEffect(() => {
    onDataChange?.(state);
  }, [state, onDataChange]);
  return null;
});

// Main component (doesn't re-render on state changes)
function MainComponent({ onDataChange }) {
  return (
    <>
      <ChangeHandler onDataChange={onDataChange} />
      <ActualUI /> {/* No state subscription */}
    </>
  );
}
```

---

## Performance Optimization

### Memoization Guidelines

**When to use:**

- Components that receive same props frequently
- Expensive computations or renders
- List items with stable data

**How to use:**

```typescript
// Icons memoization when used in components that render frequently
import { Home as _Home } from 'lucide-react';

const Home = memo(_Home);
Home.displayName = 'Home';

// Component memoization - inline pattern (preferred)
const MyComponent = memo(({ prop }: Props) => {
  // Component logic
  return <div>{prop}</div>;
});
MyComponent.displayName = 'MyComponent';
```

**Critical Rules:**

- **Never use inline functions in JSX** - Breaks memoization
- **Never use inline objects/arrays in JSX** - Creates new references
- **Always add `displayName`** - Required for debugging and dev tools

```typescript
// ❌ BAD - Inline function breaks memoization
<Button onClick={() => handle(id)} />

// ❌ BAD - Inline object creates new reference
<Component style={{ color: 'red' }} />

// ✅ GOOD - Memoized callback
const onClick = useCallback(() => handle(id), [id]);
<Button onClick={onClick} />

// ✅ GOOD - Memoized object
const style = useMemo(() => ({ color: 'red' }), []);
<Component style={style} />

// Value memoization (for expensive calculations)
const result = useMemo(() => expensiveCalc(data), [data]);
```

### Code Splitting

Use dynamic imports for:

- Route-based components
- Heavy components not needed initially
- Conditional third-party libraries

```typescript
const HeavyComponent = lazy(() => import('./heavy-component'));
```

---

## Styling Best Practices

### CSS Performance

- Use CSS `[data-*]` attributes for visibility/state
- Prefer CSS transitions over JS animations
- **Prefer Tailwind classes over inline styles** - Better performance and
  maintainability
- Use CSS Modules when Tailwind becomes too verbose
- Only use inline styles when absolutely necessary (dynamic values from API,
  etc.)

### Class Management

```typescript
import { cn } from '@/lib/utils';

// ✅ GOOD - Tailwind classes with cn()
<div className={cn(
  'h-4 w-4 rounded',
  isActive ? 'bg-primary' : 'bg-gray-500',
  className  // Allow override
)} />

// ❌ BAD - Inline styles (avoid when possible)
<div style={{
  height: '16px',
  width: '16px',
  borderRadius: '4px',
  background: isActive ? 'hsl(var(--primary))' : 'hsl(var(--gray-500))'
}} />
```

---

## Summary

Focus on:

1. **Clean architecture** - Separation of concerns
2. **Performance** - Optimize when measured, not assumed
3. **Maintainability** - Clear code over clever code
4. **User experience** - Fast, accessible, error-free
