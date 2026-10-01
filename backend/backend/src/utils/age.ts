// Age is always computed server-side from date of birth, never accepted as a
// client-sent number, anywhere in the app.
export function calculateAge(dateOfBirth: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = now.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

// The latest possible DOB for someone to be at least `age` years old today —
// used to build a `dateOfBirth <= X` filter for age-range queries.
export function latestBirthDateForMinAge(age: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  return d;
}

// The earliest possible DOB for someone to be at most `age` years old today —
// used to build a `dateOfBirth >= X` filter for age-range queries.
export function earliestBirthDateForMaxAge(age: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age - 1);
  d.setDate(d.getDate() + 1);
  return d;
}
