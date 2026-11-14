// C implementation of the variadic printf-family functions the h3 C code
// needs (h3Index.c: sprintf/sscanf with PRIx64). Compiled by zig cc with the
// same target as everything else, so the variadic ABI is consistent between
// the h3 call sites and these definitions.
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>

// Integer absolute value (declared by the stdlib.h shim; not provided by
// compiler-rt for wasm32-freestanding). Used by h3's CoordIJK absDiff.
int abs(int x) {
    return x < 0 ? -x : x;
}

static int append_int(char *buf, int pos, uint64_t v, int base, int neg) {
    static const char digits[] = "0123456789abcdef";
    char tmp[24];
    int n = 0;
    if (v == 0)
        tmp[n++] = '0';
    while (v) {
        tmp[n++] = digits[v % (uint64_t)base];
        v /= (uint64_t)base;
    }
    if (neg)
        buf[pos++] = '-';
    while (n)
        buf[pos++] = tmp[--n];
    return pos;
}

static int do_sprintf(char *str, const char *fmt, va_list ap) {
    int pos = 0;
    for (const char *f = fmt; *f; f++) {
        if (*f != '%') {
            str[pos++] = *f;
            continue;
        }
        f++;
        while (*f >= '0' && *f <= '9')
            f++; // skip width (unsupported, not needed by h3)
        int ll = 0;
        while (*f == 'l') {
            ll = 1;
            f++;
        }
        switch (*f) {
        case 'd': case 'i': {
            long long v = ll ? va_arg(ap, long long) : (long long)va_arg(ap, int);
            pos = append_int(str, pos, (uint64_t)(v < 0 ? -v : v), 10, v < 0);
            break;
        }
        case 'u': {
            unsigned long long v = ll ? va_arg(ap, unsigned long long) : (unsigned long long)va_arg(ap, unsigned int);
            pos = append_int(str, pos, v, 10, 0);
            break;
        }
        case 'x': case 'X': {
            unsigned long long v = ll ? va_arg(ap, unsigned long long) : (unsigned long long)va_arg(ap, unsigned int);
            pos = append_int(str, pos, v, 16, 0);
            break;
        }
        case 's': {
            const char *s = va_arg(ap, const char *);
            while (*s)
                str[pos++] = *s++;
            break;
        }
        case 'c': {
            str[pos++] = (char)va_arg(ap, int);
            break;
        }
        case '%':
            str[pos++] = '%';
            break;
        default:
            str[pos++] = *f;
            break;
        }
    }
    str[pos] = 0;
    return pos;
}

int sprintf(char *str, const char *fmt, ...) {
    // NOTE: no NULL check on fmt: in this build the data segment may start at
    // address 0, so a string literal's pointer can legitimately be 0.
    va_list ap;
    va_start(ap, fmt);
    int n = do_sprintf(str, fmt, ap);
    va_end(ap);
    return n;
}

int snprintf(char *str, size_t size, const char *fmt, ...) {
    if (size == 0)
        return 0;
    va_list ap;
    va_start(ap, fmt);
    char tmp[128];
    int n = do_sprintf(tmp, fmt, ap);
    va_end(ap);
    size_t copy = (size_t)n < size - 1 ? (size_t)n : size - 1;
    for (size_t i = 0; i < copy; i++)
        str[i] = tmp[i];
    str[copy] = 0;
    return n;
}

int sscanf(const char *str, const char *fmt, ...) {
    // NOTE: no NULL checks: string literals may live at address 0 (see sprintf).
    va_list ap;
    va_start(ap, fmt);
    int matched = 0;
    const char *s = str;
    for (const char *f = fmt; *f; f++) {
        if (*f != '%')
            continue;
        f++;
        while (*f >= '0' && *f <= '9')
            f++;
        int ll = 0;
        while (*f == 'l') {
            ll = 1;
            f++;
        }
        while (*s == ' ' || *s == '\t' || *s == '\n')
            s++;
        switch (*f) {
        case 'x': {
            const char *start = s;
            while ((*s >= '0' && *s <= '9') || (*s >= 'a' && *s <= 'f') || (*s >= 'A' && *s <= 'F'))
                s++;
            if (s == start)
                return matched;
            unsigned long long v = 0;
            for (const char *k = start; k < s; k++) {
                char c = *k;
                int d;
                if (c >= '0' && c <= '9')
                    d = c - '0';
                else if (c >= 'a' && c <= 'f')
                    d = c - 'a' + 10;
                else
                    d = c - 'A' + 10;
                v = v * 16 + (unsigned long long)d;
            }
            if (ll) {
                *va_arg(ap, unsigned long long *) = v;
            } else {
                *va_arg(ap, unsigned int *) = (unsigned int)v;
            }
            matched++;
            break;
        }
        case 'd': case 'i': {
            const char *start = s;
            int neg = 0;
            if (*s == '-' || *s == '+') {
                neg = *s == '-';
                s++;
            }
            while (*s >= '0' && *s <= '9')
                s++;
            if (s == start)
                return matched;
            unsigned long long v = 0;
            for (const char *k = start; k < s; k++) {
                if (*k == '-' || *k == '+')
                    continue;
                v = v * 10 + (unsigned long long)(*k - '0');
            }
            if (ll) {
                long long iv = (long long)v;
                *va_arg(ap, long long *) = neg ? -iv : iv;
            } else {
                int iv = (int)v;
                *va_arg(ap, int *) = neg ? -iv : iv;
            }
            matched++;
            break;
        }
        case 'u': {
            const char *start = s;
            while (*s >= '0' && *s <= '9')
                s++;
            if (s == start)
                return matched;
            unsigned long long v = 0;
            for (const char *k = start; k < s; k++)
                v = v * 10 + (unsigned long long)(*k - '0');
            if (ll) {
                *va_arg(ap, unsigned long long *) = v;
            } else {
                *va_arg(ap, unsigned int *) = (unsigned int)v;
            }
            matched++;
            break;
        }
        case 's': {
            const char *start = s;
            while (*s && *s != ' ' && *s != '\t' && *s != '\n')
                s++;
            if (s == start)
                return matched;
            char *dst = va_arg(ap, char *);
            for (const char *k = start; k < s; k++)
                dst[k - start] = *k;
            dst[s - start] = 0;
            matched++;
            break;
        }
        default:
            return matched;
        }
    }
    va_end(ap);
    return matched;
}

int printf(const char *fmt, ...) {
    (void)fmt;
    return 0; // no output destination in wasm; keep the symbol alive
}
