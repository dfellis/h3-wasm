/* Trivial libm functions with no exact host (Math.*) counterpart:
 * C round/lround/llround round half away from zero (Math.round rounds
 * toward +inf), and fmin/fmax have C NaN-propagation semantics.
 *
 * The expensive transcendentals (sin/cos/tan/atan/atan2/asin/acos/sqrt/
 * floor/ceil) are NOT defined here: h3.zig imports them under their C
 * names from the host env namespace, where index.js provides the Math.*
 * builtins. A software Taylor implementation of those measured 2-9x
 * slower than the host intrinsics.
 */
#include <stdint.h>
#include <math.h>

static const double BIG = 9.223372036854775808e18; /* 2^63 */

double round(double x) {
    if (x != x || x == INFINITY || x == -INFINITY)
        return x;
    if (x >= BIG || x <= -BIG)
        return x;
    return (x >= 0.0) ? floor(x + 0.5) : ceil(x - 0.5);
}

long lround(double x) {
    double r = round(x);
    if (r >= 2147483648.0)
        return 2147483647L;
    if (r <= -2147483648.0)
        return -2147483647L - 1;
    return (long)r;
}

long long llround(double x) {
    double r = round(x);
    if (r >= BIG)
        return 9223372036854775807LL;
    if (r <= -BIG)
        return -9223372036854775807LL - 1;
    return (long long)r;
}

double fmin(double x, double y) {
    if (x != x)
        return y;
    if (y != y)
        return x;
    return x < y ? x : y;
}

double fmax(double x, double y) {
    if (x != x)
        return y;
    if (y != y)
        return x;
    return x > y ? x : y;
}
