
GECKO_MAJOR ?= 9
GECKO_MINOR ?= 0
ABI_OS        ?= Linux
ABI_ARCH      ?= x86_64
ABI_COMPILER  ?= gcc3
ABI           ?= $(GECKO_MAJOR).$(GECKO_MINOR)-$(ABI_OS)_$(ABI_ARCH)-$(ABI_COMPILER)
DEFINES      = -DGECKO_MAJOR=$(GECKO_MAJOR) -DGECKO_MINOR=$(GECKO_MINOR)

SED	 ?= sed -r

GECKO_SDK_PATH := $(shell pkg-config --libs libxul | $(SED) 's,([^-]|-[^L])*-L([^ ]+)/lib.*,\2,')

CXX      ?= c++

MKDEP    ?= $(CXX) -M

PYTHON   ?= python2

CPPFLAGS +=     -fno-rtti		\
                -fno-exceptions		\
                -fshort-wchar		\
		-fPIC			\
		$(NULL)

XPIDL   ?= $(PYTHON) $(GECKO_SDK_PATH)/sdk/bin
IDL_H   ?= $(XPIDL)/header.py -o
IDL_XPT ?= $(XPIDL)/typelib.py -o
