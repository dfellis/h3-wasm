/* Software libm for wasm32-freestanding (wasm has no hardware trig/sqrt).
 *
 * Accuracy: a few ulp on the domains h3 actually uses (angles in roughly
 * [-pi, pi], coordinates in [-1, 1]). Reductions use Cody-Waite two-term
 * constants; core series are Taylor expansions carried far enough that the
 * first omitted term is below 1e-17 on the reduced domain.
 */
#include <stdint.h>
#include <math.h>

static const double PI_HI = 3.141592653589793115997963;
static const double PI_LO = 1.2246467991473531771e-16;
static const double HALFPI = 1.5707963267948965579989817;
static const double BIG = 9.223372036854775808e18; /* 2^63 */

static double bits_to_double(uint64_t bits) {
    double d;
    __builtin_memcpy(&d, &bits, 8);
    return d;
}

static uint64_t double_to_bits(double d) {
    uint64_t bits;
    __builtin_memcpy(&bits, &d, 8);
    return bits;
}

double sqrt(double x) {
    if (x < 0.0 || x != x)
        return NAN;
    if (x == 0.0 || x == INFINITY)
        return x;
    /* Initial estimate from the halved exponent: sqrt(2^e) ~= 2^(e/2).
     * Shift first, then add half the exponent bias. */
    uint64_t bits = (double_to_bits(x) >> 1) + 0x1FF8000000000000ULL;
    double y = bits_to_double(bits);
    /* Newton iteration; each step roughly doubles the correct bits. */
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    return y;
}

/* sin(r) for |r| <= pi/2, Taylor to x^21. First omitted term
 * (pi/2)^23/23! ~= 3e-19. */
static double sinreduced(double r) {
    double r2 = r * r;
    double p = 1.9572130793297006e-20;  /* +1/21! */
    p = p * r2 - 8.2204454668452860e-18; /* -1/19! */
    p = p * r2 + 2.8114177259945037e-15; /* +1/17! */
    p = p * r2 - 7.6469884681059900e-13; /* -1/15! */
    p = p * r2 + 1.6058836384939466e-10; /* +1/13! */
    p = p * r2 - 2.5052108385441720e-08; /* -1/11! */
    p = p * r2 + 2.7557319223985893e-06; /* +1/9! */
    p = p * r2 - 1.9841269841269841e-04; /* -1/7! */
    p = p * r2 + 8.3333333333333330e-03; /* +1/5! */
    p = p * r2 - 1.6666666666666666e-01; /* -1/3! */
    return r * (1.0 + p * r2);
}

/* cos(r) for |r| <= pi/2, Taylor to r^20. First omitted term
 * (pi/2)^22/22! ~= 4e-18. */
static double cosreduced(double r) {
    double r2 = r * r;
    double p = 4.1103303932821577e-19; /* +1/20! */
    p = p * r2 - 1.5619478901013059e-16; /* -1/18! */
    p = p * r2 + 4.7794491941871023e-14; /* +1/16! */
    p = p * r2 - 1.1470745559702692e-11; /* -1/14! */
    p = p * r2 + 2.0876756987868141e-09; /* +1/12! */
    p = p * r2 - 2.7557319223985893e-07; /* -1/10! */
    p = p * r2 + 2.4801587301587302e-05; /* +1/8! */
    p = p * r2 - 1.3888888888888888e-03; /* -1/6! */
    p = p * r2 + 4.1666666666666666e-02; /* +1/4! */
    p = p * r2 - 5.0000000000000000e-01; /* -1/2! */
    return 1.0 + p * r2;
}

/* Reduce x modulo pi: r in [-pi/2, pi/2] with x = n*pi + r. */
static double reduce_pi(double x, int *n_out) {
    double n = (x < 0) ? -((double)(long long)(-x / PI_HI + 0.5))
                       : (double)(long long)(x / PI_HI + 0.5);
    *n_out = (int)n;
    /* Cody-Waite: r = (x - n*PI_HI) - n*PI_LO */
    return (x - n * PI_HI) - n * PI_LO;
}

double sin(double x) {
    if (x != x)
        return x;
    if (x == INFINITY || x == -INFINITY)
        return NAN;
    if (x == 0.0)
        return x;
    int n;
    double r = reduce_pi(x, &n);
    double s = sinreduced(r);
    /* sin(n*pi + r) = (-1)^n * sin(r) */
    if (n & 1)
        s = -s;
    return s;
}

double cos(double x) {
    if (x != x)
        return x;
    if (x == INFINITY || x == -INFINITY)
        return NAN;
    int n;
    double r = reduce_pi(x, &n);
    double c = cosreduced(r);
    /* cos(n*pi + r) = (-1)^n * cos(r) */
    if (n & 1)
        c = -c;
    return c;
}

double tan(double x) {
    if (x != x)
        return x;
    return sin(x) / cos(x);
}

/* atan(x) for |x| <= 0.4142, Taylor to x^43. Omitted term at |x| = 0.4142:
 * 0.4142^45/45 ~= 1.4e-19. */
static double atanreduced(double x) {
    double x2 = x * x;
    /* inner = 1 + x2*(-1/3 + x2*(1/5 + ... + x2*(+/- 1/n))) via Horner,
     * built from the highest term down; result = x * inner. */
    double acc = 0.0;
    for (int n = 43; n >= 1; n -= 2) {
        double coef = 1.0 / (double)n;
        if ((n / 2) & 1)
            coef = -coef;
        acc = acc * x2 + coef;
    }
    return x * acc;
}

/* atan(x) for 0 <= x <= 1. For x > 0.25 use t = (sqrt(1+x^2)-1)/x, which
 * equals x/(sqrt(1+x^2)+1) in (0, 0.4142] on [0.25, 1]; atan(x) = 2*atan(t). */
static double atan_unit(double x) {
    if (x <= 0.25)
        return atanreduced(x);
    double t = (sqrt(1.0 + x * x) - 1.0) / x;
    return 2.0 * atanreduced(t);
}

double atan(double x) {
    if (x != x)
        return x;
    if (x == INFINITY)
        return HALFPI;
    if (x == -INFINITY)
        return -HALFPI;
    if (x == 0.0)
        return x;
    int neg = x < 0;
    if (neg)
        x = -x;
    double r;
    if (x <= 1.0)
        r = atan_unit(x);
    else
        r = HALFPI - atan_unit(1.0 / x);
    return neg ? -r : r;
}

double atan2(double y, double x) {
    if (x == 0.0) {
        if (y == 0.0)
            return y; /* +0 or -0 */
        return y > 0.0 ? HALFPI : -HALFPI;
    }
    if (x > 0.0)
        return atan(y / x);
    if (y >= 0.0)
        return atan(y / x) + (PI_HI + PI_LO);
    return atan(y / x) - (PI_HI + PI_LO);
}

double asin(double x) {
    if (x < -1.0 || x > 1.0 || x != x)
        return NAN;
    if (x == 1.0)
        return HALFPI;
    if (x == -1.0)
        return -HALFPI;
    return atan(x / sqrt(1.0 - x * x));
}

double acos(double x) {
    if (x < -1.0 || x > 1.0 || x != x)
        return NAN;
    if (x == 1.0)
        return 0.0;
    if (x == -1.0)
        return PI_HI + PI_LO;
    return HALFPI - asin(x);
}

double fabs(double x) {
    return x < 0.0 ? -x : x;
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

double fmod(double x, double y) {
    if (y == 0.0 || x != x || y != y || x == INFINITY || x == -INFINITY)
        return NAN;
    if (x == 0.0)
        return x;
    double q = (double)(long long)(x / y);
    double r = x - q * y;
    /* Fix up a 1-ulp rounding error in q. */
    while (r != 0.0 && (r < 0.0) != (x < 0.0) || fabs(r) >= fabs(y)) {
        q += r > 0.0 ? 1.0 : -1.0;
        r = x - q * y;
    }
    return r;
}

double floor(double x) {
    if (x != x || x == INFINITY || x == -INFINITY)
        return x;
    if (x >= BIG || x <= -BIG)
        return x;
    double t = (double)(long long)x;
    return (x < t) ? t - 1.0 : t;
}

double ceil(double x) {
    if (x != x || x == INFINITY || x == -INFINITY)
        return x;
    if (x >= BIG || x <= -BIG)
        return x;
    double t = (double)(long long)x;
    return (x > t) ? t + 1.0 : t;
}

double round(double x) {
    if (x != x || x == INFINITY || x == -INFINITY)
        return x;
    if (x >= 0.0)
        return floor(x + 0.5);
    return ceil(x - 0.5);
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
