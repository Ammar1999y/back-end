# CLAUDE.md

## Quick Start

### Core Rules

1. **Write complete, functional code** - No placeholders, follow DRY principle
2. **Ask before generating** - Clarify unclear requirements first
3. **Use English** - Convert all communication to English and talk with me in
   English, Unless I tell you otherwise
4. **No unsolicited files** - Only create files when explicitly requested
5. **Be honest** - State uncertainty instead of guessing

---

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

// Callback memoization (for memoized components)
const onClick = useCallback(() => handle(id), [id]);

// Value memoization (for expensive calculations)
const result = useMemo(() => expensiveCalc(data), [data]);
```

**Critical Rules:**

- **Never use inline functions in JSX** - Breaks memoization
- **Never use inline objects/arrays in JSX** - Creates new references
- **Always add `displayName`** - Required for debugging and dev tools
- **Never use `memo()` with components that accept `children`** - Causes
  re-render issues and breaks React's optimization. Components that render
  children should NOT be memoized.

```typescript
// ❌ BAD - Inline function breaks memoization
<Button onClick={() => handle(id)} />

// ❌ BAD - Inline object creates new reference
<Component style={{ color: 'red' }} />

// ❌ BAD - Memoizing component with children
const Wrapper = memo(({ children }) => <div>{children}</div>);

// ✅ GOOD - Memoized callback
const onClick = useCallback(() => handle(id), [id]);
<Button onClick={onClick} />

// ✅ GOOD - Memoized object
const style = useMemo(() => ({ color: 'red' }), []);
<Component style={style} />

// ✅ GOOD - No memo for components with children
export const Wrapper = ({ children }) => <div>{children}</div>;
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

## Data Tables (TanStack Table)

### Critical Rules

1. **Zustand is single source of truth** - No TanStack callbacks
2. **Update state directly** - Not through table methods
3. **Reset pagination on filter changes**

```typescript
// ✅ GOOD - Direct state management
const table = useReactTable({
  state: { pagination, sorting }, // Read-only
  // No callbacks
});

// Update via Zustand
const setPagination = useStore((s) => s.setPagination);
setPagination({ pageIndex: 0, pageSize: 10 });
```

---

## Form Handling

Use React Hook Form + Zod for validation:

```typescript
const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type FormData = z.input<typeof schema>;

const form = useForm<FormData>({
  resolver: zodResolver(schema),
});
```

---

## Styling Best Practices

### CSS Performance

- Use CSS `[data-*]` attributes for visibility/state
- Prefer CSS transitions over JS animations
- **Prefer Tailwind classes over inline styles** - Better performance and
  maintainability
- Use CSS Modules when Tailwind becomes too verbose

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

**Why prefer Tailwind over inline styles:**

- Better performance (styles are extracted to CSS)
- Easier to maintain and read
- Consistent with design system
- Better tree-shaking and smaller bundle size
- Only use inline styles when absolutely necessary (dynamic values from API,
  etc.)

---

## API Patterns

### Data Fetching (React Query)

```typescript
const { data, isLoading, error } = useQuery({
  queryKey: ['entity-name'],
  queryFn: fetchData,
});
```

---

## Security Checklist

- Validate inputs (server & client) using Zod
- Sanitize user data before rendering
- Use environment variables for secrets
- Implement proper authentication
- Never expose sensitive data client-side

---

## Accessibility Standards

- Use semantic HTML elements
- Add ARIA labels where needed
- Ensure keyboard accessibility
- Maintain proper focus management

---

## Code Review Checklist

Before completing any task:

### Architecture

- [ ] Single responsibility maintained
- [ ] Components < 200 lines
- [ ] Business logic separated from UI
- [ ] No prop drilling (use Zustand for shared state)

### Performance

- [ ] No unnecessary re-renders
- [ ] Proper memoization where needed
- [ ] Heavy components lazy-loaded

### Quality

- [ ] TypeScript errors resolved
- [ ] Error handling implemented
- [ ] DRY principle followed

### Security & Accessibility

- [ ] Input validation implemented
- [ ] Semantic HTML used
- [ ] Keyboard accessible

---

## Common Patterns Cheatsheet

### Avoid These Pitfalls

```typescript
// ❌ Object reference in dependency array
useMemo(() => calc(), [table]); // table object never changes reference

// ✅ Actual reactive values
useMemo(() => calc(), [table.getPageCount(), filters]);

// ❌ Missing displayName
export const Component = memo(() => <div />);

// ✅ With displayName
const Component = memo(() => <div />);
Component.displayName = 'Component';

// ❌ Inline functions in JSX
<Button onClick={() => handle(id)} />

// ✅ Memoized callback
const onClick = useCallback(() => handle(id), [id]);
<Button onClick={onClick} />

// ❌ Inline objects/arrays in JSX
<Component style={{ color: 'red' }} items={[1, 2, 3]} />

// ✅ Memoized objects/arrays
const style = useMemo(() => ({ color: 'red' }), []);
const items = useMemo(() => [1, 2, 3], []);
<Component style={style} items={items} />

// ❌ Using state in callbacks with dependencies
const handleClick = useCallback(() => {
  updateCount(count + 1);
}, [count]); // Re-creates callback on every count change

// ✅ Using getState() with empty dependencies
const handleClick = useCallback(() => {
  const count = useStore.getState().count;
  useStore.getState().updateCount(count + 1);
}, []); // Never re-creates
```

### Component Export Pattern

```typescript
// Memoized component - inline pattern (preferred)
const MyComponent = memo(({ prop }: Props) => {
  // Component logic
  return <div>{prop}</div>;
});
MyComponent.displayName = 'MyComponent';

export { MyComponent };
```

### State Update Pattern

```typescript
// ✅ Direct Zustand updates using getState()
useStore.getState().setState(newValue);

// ✅ Atomic selectors for specific values (only when needed for rendering)
const value = useStore(useShallow((s) => s.specific.value));

// ✅ Use getState() in callbacks to avoid subscriptions
const handleUpdate = useCallback(() => {
  const { data, setData } = useStore.getState();
  setData(processData(data));
}, []); // No dependencies needed
```

### Small Component Extraction

Extract small components when:

- Component becomes > 200 lines
- A section is reused multiple times
- A section has its own state/logic
- Improves readability significantly

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

---

## Project Configuration Files

Reference these when needed:

- **`tsconfig.json`** - TypeScript settings and path aliases
- **`eslint.config.mjs`** - Linting rules (kebab-case enforced)
- **`prettier.config.js`** - Formatting rules
- **`tailwind.config.ts`** - Theme and custom utilities
- **`package.json`** - Available scripts and dependencies

---

## Additional Implementation Notes

### When Using Specific Libraries

**Framer Motion**

- Use AnimatePresence only for exit animations
- Prefer CSS for simple transitions
- Extract animation configs outside components

**shadcn/ui**

- Install components as needed
- Customize via className props
- Extend with compound components

### Error Handling Patterns

- Use error boundaries for component trees
- Handle async errors in try-catch blocks
- Provide user-friendly error messages
- Log errors for debugging (development only)

### Testing Considerations

- Unit test utilities and hooks
- Integration test user flows
- Mock external dependencies
- Test error states and edge cases

---

## Summary

Focus on:

1. **Clean architecture** - Separation of concerns
2. **Performance** - Optimize when measured, not assumed
3. **Maintainability** - Clear code over clever code
4. **User experience** - Fast, accessible, error-free

Remember: Write code that's easy to delete, not easy to extend.
