/* math.h shim for wasm32-freestanding builds.
 * The transcendentals (sin/cos/tan/atan/atan2/asin/acos/sqrt/floor/ceil)
 * are imported from the host env namespace (see h3.zig); the remaining
 * trivial functions (round/lround/llround/fmin/fmax) live in mathcompat.c. */
#ifndef SHIM_MATH_H
#define SHIM_MATH_H

/* h3's own constants.h defines M_PI_2 too; guard to avoid redefinition warnings */
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef M_PI_2
#define M_PI_2 1.57079632679489661923
#endif
#define INFINITY (1.0 / 0.0)
#define NAN (0.0 / 0.0)

#define isfinite(x) ((x) == (x) && (x) != INFINITY && (x) != -INFINITY)

double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan(double x);
double atan2(double y, double x);
double sqrt(double x);
double fabs(double x);
/* wasm32: long double is double. Must be a macro (not a function): the Zig
 * compiler runtime also defines a `fabsl` symbol for the 128-bit long-double
 * builtin with a different signature, and the linker would silently bind the
 * call to that one (wasm-ld "function signature mismatch" warning). */
#define fabsl fabs
double fmod(double x, double y);
double floor(double x);
double ceil(double x);
double round(double x);
double fmin(double x, double y);
double fmax(double x, double y);
long lround(double x);
long long llround(double x);

#endif
